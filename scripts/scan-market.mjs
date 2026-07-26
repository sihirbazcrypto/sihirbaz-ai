import { writeFile, mkdir } from "node:fs/promises";

const OUTPUT_PATH = new URL("../public/data/dashboard.json", import.meta.url);

const ENDPOINTS = [
  "https://fapi.binance.com/fapi/v1/ticker/24hr",
  "https://fapi1.binance.com/fapi/v1/ticker/24hr",
  "https://fapi2.binance.com/fapi/v1/ticker/24hr",
  "https://fapi3.binance.com/fapi/v1/ticker/24hr",
];

const MIN_QUOTE_VOLUME = 10_000_000;
const LIMIT = 10;

function scoreCoin(change, volume) {
  const momentum = Math.min(Math.abs(change) * 6, 55);
  const liquidity = Math.min(
    Math.max(Math.log10(Math.max(volume, 1)) - 6, 0) * 12,
    45,
  );

  return Math.max(1, Math.min(100, Math.round(momentum + liquidity)));
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "SihirbazAI-GitHubActions/0.1.2",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTickers() {
  const failures = [];

  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(endpoint);

      if (!response.ok) {
        failures.push({
          endpoint,
          status: response.status,
          message: `HTTP ${response.status}`,
        });
        continue;
      }

      const data = await response.json();

      if (!Array.isArray(data) || data.length === 0) {
        failures.push({
          endpoint,
          message: "Boş veya geçersiz yanıt",
        });
        continue;
      }

      return {
        data,
        source: new URL(endpoint).hostname,
        failures,
      };
    } catch (error) {
      failures.push({
        endpoint,
        message: error instanceof Error ? error.message : "Bağlantı hatası",
      });
    }
  }

  const details = failures
    .map((item) => `${new URL(item.endpoint).hostname}: ${item.status ?? "-"} ${item.message}`)
    .join(" | ");

  throw new Error(`Tüm Binance Futures bağlantıları başarısız: ${details}`);
}

function normalizeTicker(item) {
  const change = Number(item.priceChangePercent);
  const volume = Number(item.quoteVolume);
  const price = Number(item.lastPrice);

  if (
    !item.symbol ||
    !Number.isFinite(change) ||
    !Number.isFinite(volume) ||
    !Number.isFinite(price)
  ) {
    return null;
  }

  return {
    symbol: item.symbol,
    price,
    change,
    volume,
    score: scoreCoin(change, volume),
  };
}

async function main() {
  await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });

  try {
    const { data, source, failures } = await fetchTickers();

    const coins = data
      .filter((item) => typeof item.symbol === "string" && item.symbol.endsWith("USDT"))
      .filter((item) => !item.symbol.startsWith("1000"))
      .map(normalizeTicker)
      .filter(Boolean)
      .filter((item) => item.volume >= MIN_QUOTE_VOLUME);

    const long = coins
      .filter((item) => item.change > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((item) => ({
        symbol: item.symbol,
        price: item.price.toLocaleString("en-US", { maximumFractionDigits: 8 }),
        change: item.change,
        score: item.score,
      }));

    const short = coins
      .filter((item) => item.change < 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((item) => ({
        symbol: item.symbol,
        price: item.price.toLocaleString("en-US", { maximumFractionDigits: 8 }),
        change: item.change,
        score: item.score,
      }));

    const payload = {
      ok: true,
      version: "0.1.2",
      sourceType: "github-actions",
      exchange: "Binance Futures",
      apiSource: source,
      endpointFallbacks: failures.length,
      coinCount: coins.length,
      updatedAt: new Date().toISOString(),
      updatedAtDisplay: new Date().toLocaleString("tr-TR", {
        timeZone: "Europe/Istanbul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }),
      long,
      short,
      scoringNote: "Geçici skor: 24 saatlik fiyat değişimi ve hacim.",
      failures,
    };

    await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
    console.log(`Başarılı: ${coins.length} coin tarandı. Kaynak: ${source}`);
  } catch (error) {
    const payload = {
      ok: false,
      version: "0.1.2",
      sourceType: "github-actions",
      exchange: "Binance Futures",
      coinCount: 0,
      updatedAt: new Date().toISOString(),
      updatedAtDisplay: new Date().toLocaleString("tr-TR", {
        timeZone: "Europe/Istanbul",
      }),
      long: [],
      short: [],
      error: error instanceof Error ? error.message : "Bilinmeyen hata",
    };

    await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
    console.error(payload.error);
    process.exitCode = 1;
  }
}

await main();
