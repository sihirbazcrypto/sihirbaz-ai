type BybitTicker = {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  turnover24h: string;
  fundingRate?: string;
  openInterest?: string;
  openInterestValue?: string;
};

type BybitResponse = {
  retCode: number;
  retMsg: string;
  result?: {
    category: string;
    list: BybitTicker[];
  };
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function numberOrZero(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function buildScore(
  changePct: number,
  turnover: number,
  fundingRate: number,
  openInterestValue: number,
) {
  const momentum = clamp(Math.abs(changePct) * 5, 0, 35);
  const liquidity = clamp((Math.log10(Math.max(turnover, 1)) - 6) * 10, 0, 30);
  const oi = clamp((Math.log10(Math.max(openInterestValue, 1)) - 5) * 8, 0, 20);
  const fundingHealth = clamp(15 - Math.abs(fundingRate * 10000) * 1.5, 0, 15);

  return Math.round(clamp(momentum + liquidity + oi + fundingHealth));
}

async function getBybitDashboard() {
  const endpoint =
    "https://api.bybit.com/v5/market/tickers?category=linear";

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      "user-agent": "SihirbazAI/0.2",
    },
  });

  if (!response.ok) {
    throw new Error(`Bybit API hatası: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as BybitResponse;

  if (payload.retCode !== 0 || !payload.result?.list) {
    throw new Error(
      `Bybit API yanıtı geçersiz: ${payload.retMsg || payload.retCode}`,
    );
  }

  const coins = payload.result.list
    .filter((item) => item.symbol.endsWith("USDT"))
    .map((item) => {
      const price = numberOrZero(item.lastPrice);
      const changePct = numberOrZero(item.price24hPcnt) * 100;
      const turnover = numberOrZero(item.turnover24h);
      const fundingRate = numberOrZero(item.fundingRate);
      const openInterestValue =
        numberOrZero(item.openInterestValue) ||
        numberOrZero(item.openInterest) * price;

      return {
        symbol: item.symbol,
        price,
        change: changePct,
        turnover,
        fundingRate,
        openInterestValue,
        score: buildScore(
          changePct,
          turnover,
          fundingRate,
          openInterestValue,
        ),
      };
    })
    .filter((item) => item.price > 0)
    .filter((item) => item.turnover >= 10_000_000);

  const toPublic = (item: (typeof coins)[number]) => ({
    symbol: item.symbol,
    price: item.price.toLocaleString("en-US", {
      maximumFractionDigits: 8,
    }),
    change: item.change,
    score: item.score,
    fundingRate: item.fundingRate * 100,
    openInterestValue: item.openInterestValue,
    turnover24h: item.turnover,
  });

  return {
    ok: true,
    version: "0.2.0",
    exchange: "Bybit Futures",
    sourceType: "cloudflare-worker-live",
    apiSource: "api.bybit.com",
    coinCount: coins.length,
    updatedAt: new Date().toISOString(),
    updatedAtDisplay: new Date().toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    long: coins
      .filter((item) => item.change > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(toPublic),
    short: coins
      .filter((item) => item.change < 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(toPublic),
    scoringNote:
      "İlk Bybit skoru: momentum, 24s likidite, açık pozisyon değeri ve funding sağlığı.",
  };
}

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/dashboard") {
      try {
        return json(await getBybitDashboard());
      } catch (error) {
        return json(
          {
            ok: false,
            error:
              error instanceof Error ? error.message : "Bilinmeyen hata",
          },
          502,
        );
      }
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "sihirbaz-ai",
        exchange: "Bybit Futures",
        version: "0.2.0",
        time: new Date().toISOString(),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
