type BinanceTicker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};

type MarketItem = {
  symbol: string;
  price: string;
  change: number;
  score: number;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function getBinanceDashboard() {
  const response = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if (!response.ok) throw new Error(`Binance API hatası: ${response.status}`);

  const raw = (await response.json()) as BinanceTicker[];

  const coins = raw
    .filter((item) => item.symbol.endsWith("USDT"))
    .filter((item) => !item.symbol.startsWith("1000"))
    .filter((item) => Number(item.quoteVolume) >= 10_000_000)
    .map((item) => {
      const change = Number(item.priceChangePercent);
      const volume = Number(item.quoteVolume);
      const momentum = Math.min(Math.abs(change) * 6, 55);
      const liquidity = Math.min(Math.max(Math.log10(Math.max(volume, 1)) - 6, 0) * 12, 45);
      const score = Math.max(1, Math.min(100, Math.round(momentum + liquidity)));

      return {
        symbol: item.symbol,
        price: Number(item.lastPrice).toLocaleString("en-US", { maximumFractionDigits: 8 }),
        change,
        longScore: change > 0 ? score : 0,
        shortScore: change < 0 ? score : 0,
      };
    });

  const toItem = (item: typeof coins[number], score: number): MarketItem => ({
    symbol: item.symbol,
    price: item.price,
    change: item.change,
    score,
  });

  return {
    coinCount: coins.length,
    updatedAt: new Date().toLocaleTimeString("tr-TR"),
    long: coins.filter(x => x.longScore > 0).sort((a,b) => b.longScore-a.longScore).slice(0,10).map(x => toItem(x,x.longScore)),
    short: coins.filter(x => x.shortScore > 0).sort((a,b) => b.shortScore-a.shortScore).slice(0,10).map(x => toItem(x,x.shortScore)),
    scoringNote: "Geçici skor: 24 saatlik fiyat değişimi ve hacim.",
  };
}

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/dashboard") {
      try {
        return jsonResponse(await getBinanceDashboard());
      } catch (error) {
        return jsonResponse({
          error: true,
          message: error instanceof Error ? error.message : "Bilinmeyen hata",
        }, 500);
      }
    }

    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, service: "sihirbaz-ai", time: new Date().toISOString() });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
