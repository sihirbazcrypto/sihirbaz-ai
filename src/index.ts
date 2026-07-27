
type AppEnv = Env & {
  AI: Ai;
  sihirbaz_ai_db: D1Database;
  ADMIN_SETUP_TOKEN: string;
};
type BybitTicker = {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  turnover24h: string;
  fundingRate?: string;
  openInterest?: string;
  openInterestValue?: string;
};

type BybitResponse<T> = {
  retCode: number;
  retMsg: string;
  result?: T;
};

type TickerResult = {
  category: string;
  list: BybitTicker[];
};

type KlineResult = {
  category: string;
  symbol: string;
  list: string[][];
};

type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
};

type StochRsiSnapshot = {
  k: number;
  d: number;
  zone: "oversold" | "overbought" | "middle";
  cross: "bullish" | "bearish" | "none";
};

type BbState =
  | "lower_reentry"
  | "lower_touch"
  | "middle"
  | "upper_touch"
  | "upper_reentry";

const BYBIT_BASE = "https://api.bybit.com";
const MIN_TURNOVER = 10_000_000;
const CANDIDATES_PER_SIDE = 10;
const KLINE_LIMIT = 240;

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

function num(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

async function bybitFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${BYBIT_BASE}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "SihirbazAI/0.4",
    },
  });

  if (!response.ok) {
    throw new Error(`Bybit API hatası: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as BybitResponse<T>;

  if (payload.retCode !== 0 || !payload.result) {
    throw new Error(
      `Bybit API yanıtı geçersiz: ${payload.retMsg || payload.retCode}`,
    );
  }

  return payload.result;
}

function parseCandles(list: string[][]): Candle[] {
  return list
    .map((row) => ({
      ts: num(row[0]),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
      turnover: num(row[6]),
    }))
    .filter((c) => c.close > 0)
    .sort((a, b) => a.ts - b.ts);
}

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (!slice.length) return 0;
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function stdDev(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (!slice.length) return 0;
  const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  const variance =
    slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const multiplier = 2 / (period + 1);
  let current = values[0];

  for (let i = 1; i < values.length; i += 1) {
    current = values[i] * multiplier + current * (1 - multiplier);
  }

  return current;
}

function rsiSeries(values: number[], period = 14): number[] {
  if (values.length <= period) return [];

  const result: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }

  avgGain /= period;
  avgLoss /= period;

  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return result;
}

function lastRsi(values: number[], period = 14): number {
  return rsiSeries(values, period).at(-1) ?? 50;
}

function stochRsi(values: number[]): StochRsiSnapshot {
  const rsiValues = rsiSeries(values, 14);

  if (rsiValues.length < 18) {
    return { k: 50, d: 50, zone: "middle", cross: "none" };
  }

  const raw: number[] = [];

  for (let i = 13; i < rsiValues.length; i += 1) {
    const window = rsiValues.slice(i - 13, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    const value = max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100;
    raw.push(value);
  }

  const kSeries: number[] = [];
  for (let i = 2; i < raw.length; i += 1) {
    kSeries.push((raw[i] + raw[i - 1] + raw[i - 2]) / 3);
  }

  const dSeries: number[] = [];
  for (let i = 2; i < kSeries.length; i += 1) {
    dSeries.push((kSeries[i] + kSeries[i - 1] + kSeries[i - 2]) / 3);
  }

  const k = kSeries.at(-1) ?? 50;
  const d = dSeries.at(-1) ?? 50;
  const prevK = kSeries.at(-2) ?? k;
  const prevD = dSeries.at(-2) ?? d;

  let cross: StochRsiSnapshot["cross"] = "none";
  if (prevK <= prevD && k > d) cross = "bullish";
  if (prevK >= prevD && k < d) cross = "bearish";

  return {
    k,
    d,
    zone: k <= 20 ? "oversold" : k >= 80 ? "overbought" : "middle",
    cross,
  };
}

function atrPct(candles: Candle[], period = 14): number {
  if (candles.length <= period) return 0;
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }

  const atr = sma(trs, period);
  const last = candles.at(-1)?.close ?? 0;
  return last > 0 ? (atr / last) * 100 : 0;
}

function bollingerState(values: number[], period = 20): BbState {
  if (values.length < period + 1) return "middle";

  const currentSlice = values.slice(-period);
  const previousSlice = values.slice(-(period + 1), -1);

  const currentMiddle = sma(currentSlice, period);
  const currentDev = stdDev(currentSlice, period);
  const currentLower = currentMiddle - 2 * currentDev;
  const currentUpper = currentMiddle + 2 * currentDev;

  const previousMiddle = sma(previousSlice, period);
  const previousDev = stdDev(previousSlice, period);
  const previousLower = previousMiddle - 2 * previousDev;
  const previousUpper = previousMiddle + 2 * previousDev;

  const last = values.at(-1) ?? currentMiddle;
  const previous = values.at(-2) ?? previousMiddle;
  const tolerance = Math.max((currentUpper - currentLower) * 0.06, last * 0.0005);

  if (previous < previousLower && last >= currentLower) return "lower_reentry";
  if (previous > previousUpper && last <= currentUpper) return "upper_reentry";
  if (last <= currentLower + tolerance) return "lower_touch";
  if (last >= currentUpper - tolerance) return "upper_touch";
  return "middle";
}

function volumeRatio(candles: Candle[], period = 20): number {
  if (candles.length < period + 1) return 1;
  const current = candles.at(-1)?.turnover ?? 0;
  const previous = candles.slice(-(period + 1), -1).map((c) => c.turnover);
  const avg = previous.reduce((a, b) => a + b, 0) / previous.length;
  return avg > 0 ? current / avg : 1;
}

function buildScores(
  c5: Candle[],
  c15: Candle[],
  change24h: number,
  fundingRate: number,
  openInterestValue: number,
) {
  const close5 = c5.map((c) => c.close);
  const close15 = c15.map((c) => c.close);
  const last5 = close5.at(-1) ?? 0;
  const last15 = close15.at(-1) ?? 0;

  const rsi5 = lastRsi(close5);
  const rsi15 = lastRsi(close15);
  const stoch5 = stochRsi(close5);
  const stoch15 = stochRsi(close15);

  const ema50_5 = ema(close5, 50);
  const ema50_15 = ema(close15, 50);
  const ema200_5 = ema(close5, 200);
  const ema200_15 = ema(close15, 200);

  const bb5 = bollingerState(close5);
  const bb15 = bollingerState(close15);
  const atr5 = atrPct(c5);
  const volRatio5 = volumeRatio(c5);

  const longTrendGate =
    last5 > ema50_5 &&
    last15 > ema50_15 &&
    last15 > ema200_15;

  const shortTrendGate =
    last5 < ema50_5 &&
    last15 < ema50_15 &&
    last15 < ema200_15;

  let longScore = 0;
  let shortScore = 0;
  const reasonsLong: string[] = [];
  const reasonsShort: string[] = [];
  const warningsLong: string[] = [];
  const warningsShort: string[] = [];

  if (longTrendGate) {
    longScore += 30;
    reasonsLong.push("5m ve 15m EMA50 üstü, 15m EMA200 üstü");
  } else {
    warningsLong.push("Trend onayı yok");
  }

  if (shortTrendGate) {
    shortScore += 30;
    reasonsShort.push("5m ve 15m EMA50 altı, 15m EMA200 altı");
  } else {
    warningsShort.push("Trend onayı yok");
  }

  if (stoch5.zone === "oversold") {
    longScore += 12;
    reasonsLong.push("5m Stoch RSI dip bölgede");
  }
  if (stoch5.cross === "bullish") {
    longScore += 12;
    reasonsLong.push("5m Stoch RSI yukarı kesişim");
  }
  if (stoch15.zone === "oversold") {
    longScore += 10;
    reasonsLong.push("15m Stoch RSI dip teyidi");
  }

  if (stoch5.zone === "overbought") {
    shortScore += 12;
    reasonsShort.push("5m Stoch RSI tepe bölgede");
  }
  if (stoch5.cross === "bearish") {
    shortScore += 12;
    reasonsShort.push("5m Stoch RSI aşağı kesişim");
  }
  if (stoch15.zone === "overbought") {
    shortScore += 10;
    reasonsShort.push("15m Stoch RSI tepe teyidi");
  }

  if (bb5 === "lower_reentry") {
    longScore += 16;
    reasonsLong.push("5m Bollinger altından bant içine dönüş");
  } else if (bb5 === "lower_touch") {
    longScore += 8;
    reasonsLong.push("5m Bollinger alt bant teması");
  }

  if (bb15 === "lower_reentry" || bb15 === "lower_touch") {
    longScore += 6;
    reasonsLong.push("15m Bollinger alt bölge teyidi");
  }

  if (bb5 === "upper_reentry") {
    shortScore += 16;
    reasonsShort.push("5m Bollinger üstünden bant içine dönüş");
  } else if (bb5 === "upper_touch") {
    shortScore += 8;
    reasonsShort.push("5m Bollinger üst bant teması");
  }

  if (bb15 === "upper_reentry" || bb15 === "upper_touch") {
    shortScore += 6;
    reasonsShort.push("15m Bollinger üst bölge teyidi");
  }

  if (rsi5 > 70) {
    longScore -= 18;
    warningsLong.push("5m RSI aşırı alım");
  } else if (rsi5 >= 42 && rsi5 <= 65) {
    longScore += 8;
  }

  if (rsi5 < 30) {
    shortScore -= 18;
    warningsShort.push("5m RSI aşırı satım");
  } else if (rsi5 >= 35 && rsi5 <= 62) {
    shortScore += 8;
  }

  if (rsi15 > 72) {
    longScore -= 12;
    warningsLong.push("15m RSI aşırı alım");
  }
  if (rsi15 < 28) {
    shortScore -= 12;
    warningsShort.push("15m RSI aşırı satım");
  }

  if (volRatio5 >= 1.4) {
    longScore += 8;
    shortScore += 8;
  } else if (volRatio5 < 0.35) {
    longScore -= 6;
    shortScore -= 6;
  }

  if (Math.abs(fundingRate) <= 0.0002) {
    longScore += 5;
    shortScore += 5;
  } else if (fundingRate < -0.0002) {
    longScore += 6;
    reasonsLong.push("Funding negatif");
  } else {
    shortScore += 6;
    reasonsShort.push("Funding pozitif");
  }

  if (openInterestValue >= 10_000_000) {
    longScore += 3;
    shortScore += 3;
  }

  if (change24h > 15) {
    longScore -= Math.min(20, (change24h - 15) * 1.2);
    warningsLong.push("24s hareket aşırı uzamış");
  }
  if (change24h < -15) {
    shortScore -= Math.min(20, (Math.abs(change24h) - 15) * 1.2);
    warningsShort.push("24s düşüş aşırı uzamış");
  }

  if (atr5 > 4) {
    longScore -= 8;
    shortScore -= 8;
  }

  if (!longTrendGate) longScore = Math.min(longScore, 49);
  if (!shortTrendGate) shortScore = Math.min(shortScore, 49);

  if (rsi5 > 75) longScore = Math.min(longScore, 35);
  if (rsi5 < 25) shortScore = Math.min(shortScore, 35);

  return {
    rsi5,
    rsi15,
    stoch5,
    stoch15,
    emaSide5: last5 >= ema50_5 ? "above" : "below",
    emaSide15: last15 >= ema50_15 ? "above" : "below",
    ema200Side15: last15 >= ema200_15 ? "above" : "below",
    bb5,
    bb15,
    atrPct5: atr5,
    volumeRatio5: volRatio5,
    longScore: Math.round(clamp(longScore)),
    shortScore: Math.round(clamp(shortScore)),
    longReady: longTrendGate && longScore >= 70,
    shortReady: shortTrendGate && shortScore >= 70,
    reasonsLong: reasonsLong.slice(0, 6),
    reasonsShort: reasonsShort.slice(0, 6),
    warningsLong: warningsLong.slice(0, 3),
    warningsShort: warningsShort.slice(0, 3),
  };
}

async function getKlines(
  symbol: string,
  interval: "1" | "5" | "15" | "60",
  limit = KLINE_LIMIT,
): Promise<Candle[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const result = await bybitFetch<KlineResult>(
    `/v5/market/kline?category=linear&symbol=${encodeURIComponent(
      symbol,
    )}&interval=${interval}&limit=${safeLimit}`,
  );
  return parseCandles(result.list);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
}

async function getDashboard() {
  const tickerResult = await bybitFetch<TickerResult>(
    "/v5/market/tickers?category=linear",
  );

  const liquid = tickerResult.list
    .filter((item) => item.symbol.endsWith("USDT"))
    .map((item) => {
      const price = num(item.lastPrice);
      const change = num(item.price24hPcnt) * 100;
      const turnover = num(item.turnover24h);
      const fundingRate = num(item.fundingRate);
      const openInterestValue =
        num(item.openInterestValue) || num(item.openInterest) * price;

      return {
        symbol: item.symbol,
        price,
        change,
        turnover,
        fundingRate,
        openInterestValue,
      };
    })
    .filter((item) => item.price > 0 && item.turnover >= MIN_TURNOVER);

  const gainers = [...liquid]
    .filter((item) => item.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, CANDIDATES_PER_SIDE);

  const losers = [...liquid]
    .filter((item) => item.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, CANDIDATES_PER_SIDE);

  const candidates = Array.from(
    new Map(
      [...gainers, ...losers].map((item) => [item.symbol, item]),
    ).values(),
  );

  const analysed = await mapWithConcurrency(candidates, 5, async (item) => {
    const [c5, c15] = await Promise.all([
      getKlines(item.symbol, "5"),
      getKlines(item.symbol, "15"),
    ]);

    return {
      symbol: item.symbol,
      price: item.price.toLocaleString("en-US", {
        maximumFractionDigits: 8,
      }),
      change: item.change,
      fundingRate: item.fundingRate * 100,
      openInterestValue: item.openInterestValue,
      turnover24h: item.turnover,
      ...buildScores(
        c5,
        c15,
        item.change,
        item.fundingRate,
        item.openInterestValue,
      ),
    };
  });

  return {
    ok: true,
    version: "2.0.0",
    exchange: "Bybit Futures",
    sourceType: "cloudflare-worker-live",
    apiSource: "api.bybit.com",
    scannedMarketCount: liquid.length,
    analysedCoinCount: analysed.length,
    updatedAtDisplay: new Date().toLocaleTimeString("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    long: [...analysed]
      .sort((a, b) => b.longScore - a.longScore)
      .slice(0, 10),
    short: [...analysed]
      .sort((a, b) => b.shortScore - a.shortScore)
      .slice(0, 10),
  };
}


function emaSeries(values: number[], period: number): Array<number | null> {
  if (!values.length) return [];
  const result: Array<number | null> = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let current = values[0];

  for (let i = 0; i < values.length; i += 1) {
    if (i === 0) {
      current = values[0];
    } else {
      current = values[i] * multiplier + current * (1 - multiplier);
    }
    if (i >= period - 1) result[i] = current;
  }

  return result;
}

function bollingerSeries(
  values: number[],
  period = 20,
): {
  upper: Array<number | null>;
  middle: Array<number | null>;
  lower: Array<number | null>;
} {
  const upper: Array<number | null> = new Array(values.length).fill(null);
  const middle: Array<number | null> = new Array(values.length).fill(null);
  const lower: Array<number | null> = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const variance =
      window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);

    middle[i] = mean;
    upper[i] = mean + 2 * deviation;
    lower[i] = mean - 2 * deviation;
  }

  return { upper, middle, lower };
}

function stochRsiSeries(values: number[]): {
  k: Array<number | null>;
  d: Array<number | null>;
} {
  const rsiValues = rsiSeries(values, 14);
  const offset = values.length - rsiValues.length;
  const raw: number[] = [];

  for (let i = 13; i < rsiValues.length; i += 1) {
    const window = rsiValues.slice(i - 13, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    raw.push(max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100);
  }

  const kRaw: number[] = [];
  for (let i = 2; i < raw.length; i += 1) {
    kRaw.push((raw[i] + raw[i - 1] + raw[i - 2]) / 3);
  }

  const dRaw: number[] = [];
  for (let i = 2; i < kRaw.length; i += 1) {
    dRaw.push((kRaw[i] + kRaw[i - 1] + kRaw[i - 2]) / 3);
  }

  const k: Array<number | null> = new Array(values.length).fill(null);
  const d: Array<number | null> = new Array(values.length).fill(null);

  const kStart = offset + 13 + 2;
  const dStart = kStart + 2;

  kRaw.forEach((value, index) => {
    const target = kStart + index;
    if (target < k.length) k[target] = value;
  });

  dRaw.forEach((value, index) => {
    const target = dStart + index;
    if (target < d.length) d[target] = value;
  });

  return { k, d };
}

function safeAiText(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "response" in result &&
    typeof (result as { response?: unknown }).response === "string"
  ) {
    return (result as { response: string }).response.trim();
  }

  if (typeof result === "string") return result.trim();
  return "Yapay zekâ yorumu oluşturulamadı.";
}

function estimateTradePlan(
  side: "long" | "short",
  entry: number,
  atrPctValue: number,
  score: number,
) {
  const atrDistance = Math.max(entry * (atrPctValue / 100), entry * 0.004);
  const riskMultiplier = score >= 85 ? 0.9 : score >= 70 ? 1.0 : 1.15;
  const stopDistance = atrDistance * riskMultiplier;

  if (side === "long") {
    const sl = entry - stopDistance;
    return {
      entry,
      sl,
      tp1: entry + stopDistance * 1.2,
      tp2: entry + stopDistance * 2.0,
      tp3: entry + stopDistance * 3.0,
      riskReward: 2.0,
    };
  }

  const sl = entry + stopDistance;
  return {
    entry,
    sl,
    tp1: entry - stopDistance * 1.2,
    tp2: entry - stopDistance * 2.0,
    tp3: entry - stopDistance * 3.0,
    riskReward: 2.0,
  };
}

function riskLabel(score: number, atrPctValue: number) {
  if (score >= 82 && atrPctValue <= 1.5) return "Düşük";
  if (score >= 65 && atrPctValue <= 3) return "Orta";
  return "Yüksek";
}

function rating(score: number) {
  if (score >= 90) return 5;
  if (score >= 80) return 4;
  if (score >= 68) return 3;
  if (score >= 55) return 2;
  return 1;
}

async function getCoinDetail(symbol: string) {
  const tickerResult = await bybitFetch<TickerResult>(
    "/v5/market/tickers?category=linear",
  );

  const ticker = tickerResult.list.find((item) => item.symbol === symbol);
  if (!ticker) throw new Error("Coin bulunamadı");

  const [c5, c15] = await Promise.all([
    getKlines(symbol, "5"),
    getKlines(symbol, "15"),
  ]);

  const price = num(ticker.lastPrice);
  const change = num(ticker.price24hPcnt) * 100;
  const fundingRate = num(ticker.fundingRate);
  const openInterestValue =
    num(ticker.openInterestValue) || num(ticker.openInterest) * price;

  const analysis = buildScores(
    c5,
    c15,
    change,
    fundingRate,
    openInterestValue,
  );

  const preferredSide =
    analysis.longScore >= analysis.shortScore ? "long" : "short";
  const preferredScore =
    preferredSide === "long" ? analysis.longScore : analysis.shortScore;
  const ready =
    preferredSide === "long" ? analysis.longReady : analysis.shortReady;
  const reasons =
    preferredSide === "long"
      ? analysis.reasonsLong
      : analysis.reasonsShort;
  const warnings =
    preferredSide === "long"
      ? analysis.warningsLong
      : analysis.warningsShort;

  return {
    ok: true,
    version: "2.0.0",
    symbol,
    exchange: "Bybit Futures",
    price,
    change,
    fundingRate: fundingRate * 100,
    openInterestValue,
    side: preferredSide,
    score: preferredScore,
    ready,
    stars: rating(preferredScore),
    risk: riskLabel(preferredScore, analysis.atrPct5),
    plan: estimateTradePlan(
      preferredSide,
      price,
      analysis.atrPct5,
      preferredScore,
    ),
    reasons,
    warnings,
    analysis,
    candles5: c5.slice(-160),
    candles15: c15.slice(-160),
    indicators5: {
      ema50: emaSeries(c5.map((c) => c.close), 50).slice(-160),
      ema200: emaSeries(c5.map((c) => c.close), 200).slice(-160),
      bollinger: {
        upper: bollingerSeries(c5.map((c) => c.close), 20).upper.slice(-100),
        middle: bollingerSeries(c5.map((c) => c.close), 20).middle.slice(-100),
        lower: bollingerSeries(c5.map((c) => c.close), 20).lower.slice(-100),
      },
      rsi: rsiSeries(c5.map((c) => c.close), 14)
        .map((value) => value)
        .slice(-100),
      stochRsi: {
        k: stochRsiSeries(c5.map((c) => c.close)).k.slice(-100),
        d: stochRsiSeries(c5.map((c) => c.close)).d.slice(-100),
      },
    },
    indicators15: {
      ema50: emaSeries(c15.map((c) => c.close), 50).slice(-160),
      ema200: emaSeries(c15.map((c) => c.close), 200).slice(-160),
      bollinger: {
        upper: bollingerSeries(c15.map((c) => c.close), 20).upper.slice(-160),
        middle: bollingerSeries(c15.map((c) => c.close), 20).middle.slice(-160),
        lower: bollingerSeries(c15.map((c) => c.close), 20).lower.slice(-160),
      },
      rsi: (() => {
        const values = rsiSeries(c15.map((c) => c.close), 14);
        const aligned: Array<number | null> = new Array(c15.length).fill(null);
        const start = c15.length - values.length;
        values.forEach((value, index) => {
          aligned[start + index] = value;
        });
        return aligned.slice(-160);
      })(),
      stochRsi: {
        k: stochRsiSeries(c15.map((c) => c.close)).k.slice(-160),
        d: stochRsiSeries(c15.map((c) => c.close)).d.slice(-160),
      },
    },
    updatedAtDisplay: new Date().toLocaleTimeString("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}


function pctChange(from: number, to: number): number {
  return from !== 0 ? ((to - from) / from) * 100 : 0;
}

function linearSlopePct(values: number[], lookback: number): number {
  const slice = values.slice(-lookback);
  if (slice.length < 2 || slice[0] === 0) return 0;
  return pctChange(slice[0], slice.at(-1) ?? slice[0]);
}

function recentRangePosition(candles: Candle[], lookback = 40): number {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0.5;
  const high = Math.max(...slice.map((c) => c.high));
  const low = Math.min(...slice.map((c) => c.low));
  const close = slice.at(-1)?.close ?? low;
  return high === low ? 0.5 : clamp((close - low) / (high - low), 0, 1);
}

function detectStructure(candles: Candle[]) {
  const slice = candles.slice(-80);
  const closes = slice.map((c) => c.close);
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);

  const recent20 = slice.slice(-20);
  const previous20 = slice.slice(-40, -20);

  const recentHigh = recent20.length
    ? Math.max(...recent20.map((c) => c.high))
    : 0;
  const recentLow = recent20.length
    ? Math.min(...recent20.map((c) => c.low))
    : 0;
  const previousHigh = previous20.length
    ? Math.max(...previous20.map((c) => c.high))
    : recentHigh;
  const previousLow = previous20.length
    ? Math.min(...previous20.map((c) => c.low))
    : recentLow;

  let structure = "yatay";
  if (recentHigh > previousHigh && recentLow > previousLow) {
    structure = "yükselen tepe ve yükselen dip";
  } else if (recentHigh < previousHigh && recentLow < previousLow) {
    structure = "düşen tepe ve düşen dip";
  } else if (recentHigh > previousHigh && recentLow < previousLow) {
    structure = "genişleyen volatilite";
  }

  const last = slice.at(-1);
  const previous = slice.at(-2);
  const bodyPct =
    last && last.open !== 0
      ? (Math.abs(last.close - last.open) / last.open) * 100
      : 0;

  return {
    structure,
    slope20Pct: linearSlopePct(closes, 20),
    slope50Pct: linearSlopePct(closes, 50),
    rangePosition: recentRangePosition(slice, 40),
    recentHigh,
    recentLow,
    previousHigh,
    previousLow,
    lastCandle: last
      ? {
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
          bodyPct,
          direction: last.close >= last.open ? "yeşil" : "kırmızı",
        }
      : null,
    lastCloseChangePct:
      last && previous ? pctChange(previous.close, last.close) : 0,
    highest80: highs.length ? Math.max(...highs) : 0,
    lowest80: lows.length ? Math.min(...lows) : 0,
  };
}

function compactCandles(candles: Candle[], count: number) {
  return candles.slice(-count).map((c) => [
    c.ts,
    Number(c.open.toPrecision(8)),
    Number(c.high.toPrecision(8)),
    Number(c.low.toPrecision(8)),
    Number(c.close.toPrecision(8)),
    Number(c.turnover.toPrecision(7)),
  ]);
}

function agreementLabel(
  engineSide: "long" | "short",
  engineScore: number,
  aiDecision: string,
) {
  const normalized = aiDecision.toUpperCase();
  const same =
    (engineSide === "long" && normalized.includes("LONG")) ||
    (engineSide === "short" && normalized.includes("SHORT"));

  if (same && engineScore >= 70) return "Yüksek";
  if (same) return "Orta";
  if (normalized.includes("BEKLE") || normalized.includes("İŞLEM YOK")) {
    return "Düşük";
  }
  return "Çelişkili";
}

function extractDecision(text: string): string {
  const match = text.match(/AI KARARI\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim() || "NET DEĞİL";
}

async function getAiComment(
  env: AppEnv,
  detail: Awaited<ReturnType<typeof getCoinDetail>>,
): Promise<{
  comment: string;
  decision: string;
  agreement: string;
}> {
  const candles15 = await getKlines(detail.symbol, "15");
  const candles60 = await getKlines(detail.symbol, "60");

  const structure5 = detectStructure(detail.candles5);
  const structure15 = detectStructure(candles15);
  const structure60 = detectStructure(candles60);

  const marketPacket = {
    symbol: detail.symbol,
    exchange: detail.exchange,
    currentPrice: detail.price,
    change24hPct: detail.change,
    fundingPct: detail.fundingRate,
    openInterestUsd: detail.openInterestValue,
    ruleEngine: {
      preferredSide: detail.side,
      score: detail.score,
      status: detail.ready ? "HAZIR" : "IZLE",
      risk: detail.risk,
    },
    structure: {
      m5: structure5,
      m15: structure15,
      h1: structure60,
    },
    candles: {
      m5_last40: compactCandles(detail.candles5, 40),
      m15_last32: compactCandles(candles15, 32),
      h1_last24: compactCandles(candles60, 24),
      format: "[timestamp,open,high,low,close,turnover]",
    },
  };

  const prompt = `
Sen bağımsız çalışan, ihtiyatlı bir kripto vadeli işlem piyasa analistisin.

ÖNEMLİ KURALLAR:
- Kural motorunun yönüne ve skoruna katılmak zorunda değilsin.
- Hazır teknik neden listesini tekrar etme.
- Öncelikle ham OHLCV mumlarını ve 5m/15m/1h piyasa yapısını kendin değerlendir.
- Son tepe/dip ilişkisi, trend devamı veya bozulması, mum davranışı, volatilite,
  hacim/turnover, fiyatın son aralık içindeki konumu, funding ve açık pozisyonu birlikte yorumla.
- Veri yeterli değilse açıkça söyle.
- Kesin kazanç, garanti, başarı ihtimali veya yatırım tavsiyesi verme.
- Gerekirse kural motoruyla çeliş.
- Türkçe ve en fazla 180 kelime yaz.

PİYASA VERİ PAKETİ:
${JSON.stringify(marketPacket)}

Yanıtı tam olarak şu başlıklarla ver:

BAĞIMSIZ PİYASA OKUMASI:
[Ham fiyat yapısını kendi yorumunla açıkla.]

PİYASA YAPISI VE KIRILIM:
[Katıldığın veya çeliştiğin noktayı açıkla.]

ANA RİSK:
[En önemli tek riski belirt.]

AI KARARI:
[Yalnızca şu seçeneklerden biri: LONG İZLE, SHORT İZLE, GERİ ÇEKİLME BEKLE, TEPKİ BEKLE, İŞLEM YOK]
`;

  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content:
          "Sen ham piyasa verisini bağımsız analiz eden ve kural motoruna gerektiğinde itiraz eden temkinli bir piyasa analistisin.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 420,
    temperature: 0.35,
  });

  const comment = safeAiText(result);
  const decision = extractDecision(comment);

  return {
    comment,
    decision,
    agreement: agreementLabel(detail.side as "long" | "short", detail.score, decision),
  };
}


type TraderAiDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
type TraderAiAction =
  | "LONG_SETUP_WATCH"
  | "SHORT_SETUP_WATCH"
  | "WAIT_PULLBACK"
  | "WAIT_RETEST"
  | "WAIT_BREAKOUT"
  | "NO_TRADE";
type TraderAiRisk = "LOW" | "MEDIUM" | "HIGH";

type TraderAiOutput = {
  market_direction: TraderAiDirection;
  trade_action: TraderAiAction;
  risk: TraderAiRisk;
  confidence: number;
  entry_condition: string;
  invalidation: string;
  rationale: string[];
  warning: string;
};

function traderAiSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      market_direction: {
        type: "string",
        enum: ["BULLISH", "BEARISH", "NEUTRAL"],
      },
      trade_action: {
        type: "string",
        enum: [
          "LONG_SETUP_WATCH",
          "SHORT_SETUP_WATCH",
          "WAIT_PULLBACK",
          "WAIT_RETEST",
          "WAIT_BREAKOUT",
          "NO_TRADE",
        ],
      },
      risk: {
        type: "string",
        enum: ["LOW", "MEDIUM", "HIGH"],
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 100,
      },
      entry_condition: { type: "string" },
      invalidation: { type: "string" },
      rationale: {
        type: "array",
        minItems: 2,
        maxItems: 5,
        items: { type: "string" },
      },
      warning: { type: "string" },
    },
    required: [
      "market_direction",
      "trade_action",
      "risk",
      "confidence",
      "entry_condition",
      "invalidation",
      "rationale",
      "warning",
    ],
  };
}

function parseTraderAiResult(result: unknown): TraderAiOutput {
  const raw =
    result &&
    typeof result === "object" &&
    "response" in result
      ? (result as { response: unknown }).response
      : result;

  if (raw && typeof raw === "object") {
    return raw as TraderAiOutput;
  }

  if (typeof raw === "string") {
    return JSON.parse(raw) as TraderAiOutput;
  }

  throw new Error("AI yapılandırılmış yanıt üretmedi");
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function candleSlope(candles: unknown): number {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!Array.isArray(first) || !Array.isArray(last)) return 0;
  const firstClose = finiteNumber(first[4]);
  const lastClose = finiteNumber(last[4]);
  return firstClose !== 0
    ? ((lastClose - firstClose) / firstClose) * 100
    : 0;
}

function independentMarketGuard(marketPacket: unknown): {
  direction: TraderAiDirection;
  bullishPoints: number;
  bearishPoints: number;
  stretchedUp: boolean;
  stretchedDown: boolean;
  breakout5: string;
  breakout15: string;
  slope5: number;
  slope15: number;
} {
  const packet =
    marketPacket && typeof marketPacket === "object"
      ? (marketPacket as Record<string, unknown>)
      : {};

  const change24h = finiteNumber(packet.change24hPct);
  const levels =
    packet.levels && typeof packet.levels === "object"
      ? (packet.levels as Record<string, unknown>)
      : {};
  const breakout5 = String(levels.breakout5 || "none");
  const breakout15 = String(levels.breakout15 || "none");

  const candles =
    packet.candles && typeof packet.candles === "object"
      ? (packet.candles as Record<string, unknown>)
      : {};
  const slope5 = candleSlope(candles.m5);
  const slope15 = candleSlope(candles.m15);

  let bullishPoints = 0;
  let bearishPoints = 0;

  if (breakout5 === "up") bullishPoints += 3;
  if (breakout15 === "up") bullishPoints += 4;
  if (breakout5 === "down") bearishPoints += 3;
  if (breakout15 === "down") bearishPoints += 4;

  if (slope5 > 0.6) bullishPoints += 2;
  if (slope15 > 1.0) bullishPoints += 3;
  if (slope5 < -0.6) bearishPoints += 2;
  if (slope15 < -1.0) bearishPoints += 3;

  if (change24h > 4) bullishPoints += 1;
  if (change24h < -4) bearishPoints += 1;

  const direction: TraderAiDirection =
    bullishPoints >= bearishPoints + 3
      ? "BULLISH"
      : bearishPoints >= bullishPoints + 3
        ? "BEARISH"
        : "NEUTRAL";

  return {
    direction,
    bullishPoints,
    bearishPoints,
    stretchedUp: change24h >= 10,
    stretchedDown: change24h <= -10,
    breakout5,
    breakout15,
    slope5,
    slope15,
  };
}

function enforceTraderConsistency(
  ai: TraderAiOutput,
  marketPacket: unknown,
): TraderAiOutput {
  const guard = independentMarketGuard(marketPacket);
  const output: TraderAiOutput = {
    ...ai,
    confidence: Math.max(0, Math.min(100, Math.round(ai.confidence))),
    rationale: Array.isArray(ai.rationale) ? ai.rationale.slice(0, 5) : [],
  };

  if (guard.direction === "BEARISH") {
    output.market_direction = "BEARISH";

    if (guard.stretchedDown) {
      output.trade_action = "WAIT_RETEST";
      output.entry_condition =
        "Düşüşü kovalamak yerine kırılan desteğin aşağıdan test edilmesini ve reddedilmesini bekle.";
    } else if (
      guard.breakout5 === "down" ||
      guard.breakout15 === "down"
    ) {
      output.trade_action = "SHORT_SETUP_WATCH";
      output.entry_condition =
        "Destek altında kapanışın korunması veya kırılan seviyenin direnç olarak çalışması gerekir.";
    } else {
      output.trade_action = "WAIT_BREAKOUT";
      output.entry_condition =
        "Yeni short yaklaşımı için geçerli desteğin altında teyitli kapanış bekle.";
    }

    if (
      ai.market_direction === "BULLISH" ||
      ai.trade_action === "LONG_SETUP_WATCH"
    ) {
      output.warning =
        "Modelin ilk long eğilimi ham fiyat yapısıyla çeliştiği için güvenlik filtresi tarafından reddedildi.";
    }
  }

  if (guard.direction === "BULLISH") {
    output.market_direction = "BULLISH";

    if (guard.stretchedUp) {
      output.trade_action = "WAIT_PULLBACK";
      output.entry_condition =
        "Yükselişi kovalamak yerine kırılan direncin destek olarak test edilmesini bekle.";
    } else if (
      guard.breakout5 === "up" ||
      guard.breakout15 === "up"
    ) {
      output.trade_action = "LONG_SETUP_WATCH";
      output.entry_condition =
        "Direnç üstü kapanış korunmalı veya kırılan seviye destek olarak doğrulanmalı.";
    } else {
      output.trade_action = "WAIT_BREAKOUT";
      output.entry_condition =
        "Yeni long yaklaşımı için geçerli direncin üzerinde teyitli kapanış bekle.";
    }

    if (
      ai.market_direction === "BEARISH" ||
      ai.trade_action === "SHORT_SETUP_WATCH"
    ) {
      output.warning =
        "Modelin ilk short eğilimi ham fiyat yapısıyla çeliştiği için güvenlik filtresi tarafından reddedildi.";
    }
  }

  if (guard.direction === "NEUTRAL") {
    output.market_direction = "NEUTRAL";
    output.trade_action = "NO_TRADE";
    output.entry_condition =
      "5m ve 15m yönü aynı tarafa dönmeden ve destek/direnç kırılımı teyit edilmeden işlem yaklaşımı oluşturma.";
    output.confidence = Math.min(output.confidence, 55);
  }

  if (output.rationale.length < 2) {
    output.rationale = [
      `5m fiyat eğimi: %${guard.slope5.toFixed(2)}`,
      `15m fiyat eğimi: %${guard.slope15.toFixed(2)}`,
    ];
  }

  return output;
}

function directionTr(value: TraderAiDirection): string {
  if (value === "BULLISH") return "YUKARI YÖNLÜ";
  if (value === "BEARISH") return "AŞAĞI YÖNLÜ";
  return "NÖTR / KARARSIZ";
}

function actionTr(value: TraderAiAction): string {
  const map: Record<TraderAiAction, string> = {
    LONG_SETUP_WATCH: "LONG KURULUMU İZLE",
    SHORT_SETUP_WATCH: "SHORT KURULUMU İZLE",
    WAIT_PULLBACK: "GERİ ÇEKİLME BEKLE",
    WAIT_RETEST: "KIRILAN SEVİYE TESTİNİ BEKLE",
    WAIT_BREAKOUT: "KIRILIM TEYİDİ BEKLE",
    NO_TRADE: "İŞLEM YOK",
  };
  return map[value];
}

function riskTr(value: TraderAiRisk): string {
  if (value === "LOW") return "DÜŞÜK";
  if (value === "MEDIUM") return "ORTA";
  return "YÜKSEK";
}

function formatTraderComment(ai: TraderAiOutput): string {
  return [
    `PİYASA YÖNÜ: ${directionTr(ai.market_direction)}`,
    `İŞLEM YAKLAŞIMI: ${actionTr(ai.trade_action)}`,
    `RİSK: ${riskTr(ai.risk)}`,
    `GÜVEN: ${ai.confidence}/100`,
    "",
    "TRADER GEREKÇESİ:",
    ...ai.rationale.map((item) => `• ${item}`),
    "",
    `GİRİŞ İÇİN GEREKEN TEYİT: ${ai.entry_condition}`,
    `GEÇERSİZLİK: ${ai.invalidation}`,
    `UYARI: ${ai.warning}`,
  ].join("\n");
}

async function fetchMexcPublic(path: string): Promise<Response> {
  const allowed =
    path === "/api/v1/contract/ticker" ||
    path.startsWith("/api/v1/contract/kline/") ||
    path.startsWith("/api/v1/contract/funding_rate/");

  if (!allowed) {
    return json({ ok: false, error: "MEXC yolu izinli değil" }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`https://contract.mexc.com${path}`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "SihirbazAI/1.1",
      },
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ||
          "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}



type RadarEvent = {
  symbol: string;
  exchange: string;
  timeframe: "1m" | "5m" | "15m" | "1h";
  type: string;
  detail: string;
  value?: number;
  direction?: "up" | "down" | "neutral";
  eventKey: string;
  time: string;
};

function pctMove(candles: Candle[], bars = 1): number {
  if (candles.length <= bars) return 0;
  const start = candles.at(-(bars + 1))?.close || 0;
  const end = candles.at(-1)?.close || 0;
  return start ? ((end - start) / start) * 100 : 0;
}

function radarVolumeRatio(candles: Candle[], lookback = 20): number {
  if (candles.length < 3) return 1;
  const last = candles.at(-1)?.volume || 0;
  const previous = candles.slice(-(lookback + 1), -1).map((c) => c.volume);
  const avg = previous.reduce((a, b) => a + b, 0) / Math.max(previous.length, 1);
  return avg > 0 ? last / avg : 1;
}

function radarLevels(candles: Candle[], lookback = 20) {
  const previous = candles.slice(-(lookback + 1), -1);
  return {
    resistance: Math.max(...previous.map((c) => c.high)),
    support: Math.min(...previous.map((c) => c.low)),
  };
}

function lastEma(values: number[], period: number): number {
  return ema(values, period);
}

function eventTime(): string {
  return new Date().toLocaleTimeString("tr-TR", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function getMarketRadar(): Promise<{ ok: true; updatedAt: string; events: RadarEvent[] }> {
  const tickerResult = await bybitFetch<TickerResult>("/v5/market/tickers?category=linear");
  const liquid = tickerResult.list
    .filter((item) => item.symbol.endsWith("USDT") && num(item.turnover24h) >= MIN_TURNOVER)
    .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
    .slice(0, 8);

  const events = (await mapWithConcurrency(liquid, 4, async (ticker) => {
    const symbol = ticker.symbol;
    const [c1, c5, c15, c60] = await Promise.all([
      getKlines(symbol, "1", 80),
      getKlines(symbol, "5", 220),
      getKlines(symbol, "15", 220),
      getKlines(symbol, "60", 220),
    ]);
    const now = eventTime();
    const out: RadarEvent[] = [];
    const add = (timeframe: RadarEvent["timeframe"], type: string, detail: string, direction: RadarEvent["direction"] = "neutral", value?: number) => {
      out.push({ symbol, exchange: "Bybit Futures", timeframe, type, detail, direction, value, time: now, eventKey: `${symbol}|Bybit|${timeframe}|${type}` });
    };

    for (const [tf, candles, bars] of [["1m", c1, 1], ["5m", c1, 5]] as const) {
      const move = pctMove(candles, bars);
      if (Math.abs(move) >= 2) add(tf, "% Hareket", `%${Math.abs(move).toFixed(2)} ${move > 0 ? "yükseliş" : "düşüş"}`, move > 0 ? "up" : "down", move);
    }

    for (const [tf, candles] of [["1m", c1], ["5m", c5], ["15m", c15]] as const) {
      const ratio = radarVolumeRatio(candles);
      if (ratio >= 1.5) add(tf, "Hacim Girişi", `Hacim ${ratio.toFixed(2)}x`, "neutral", ratio);
    }

    for (const [tf, candles] of [["5m", c5], ["15m", c15]] as const) {
      if (candles.length < 25) continue;
      const levels = radarLevels(candles);
      const last = candles.at(-1)!;
      const prev = candles.at(-2)!;
      if (last.close > levels.resistance) add(tf, "Direnç Kırılımı", `Direnç ${levels.resistance.toPrecision(7)} üstü kapanış`, "up", last.close);
      if (last.close < levels.support) add(tf, "Destek Kırılımı", `Destek ${levels.support.toPrecision(7)} altı kapanış`, "down", last.close);
      const tolerance = Math.max(last.close * 0.0025, Math.abs(last.high - last.low) * 0.35);
      if (prev.close > levels.resistance && Math.abs(last.low - levels.resistance) <= tolerance && last.close >= levels.resistance) add(tf, "Direnç Retest", "Kırılan direnç üzerinde başarılı retest", "up");
      if (prev.close < levels.support && Math.abs(last.high - levels.support) <= tolerance && last.close <= levels.support) add(tf, "Destek Retest", "Kırılan destek altında başarılı retest", "down");
      if (last.high > levels.resistance && last.close < levels.resistance) add(tf, "Sahte Kırılım", "Direnç üstü fitil, seviye altında kapanış", "down");
      if (last.low < levels.support && last.close > levels.support) add(tf, "Sahte Kırılım", "Destek altı fitil, seviye üstünde kapanış", "up");
    }

    const close5 = c5.map((c) => c.close);
    if (close5.length >= 202) {
      const e50Now = lastEma(close5, 50), e200Now = lastEma(close5, 200);
      const prior = close5.slice(0, -1);
      const e50Prev = lastEma(prior, 50), e200Prev = lastEma(prior, 200);
      const price = close5.at(-1)!;
      const prevPrice = close5.at(-2)!;
      if (e50Prev <= e200Prev && e50Now > e200Now) add("5m", "Golden Cross", "EMA50, EMA200 üzerine kesti", "up");
      if (e50Prev >= e200Prev && e50Now < e200Now) add("5m", "Death Cross", "EMA50, EMA200 altına kesti", "down");
      const touchTolerance = price * 0.002;
      if (Math.abs(price - e50Now) <= touchTolerance || (prevPrice < e50Now && price >= e50Now) || (prevPrice > e50Now && price <= e50Now)) add("5m", "EMA50 Teması", `EMA50 ${e50Now.toPrecision(7)} teması/geçişi`, price >= e50Now ? "up" : "down");
      if (Math.abs(price - e200Now) <= touchTolerance || (prevPrice < e200Now && price >= e200Now) || (prevPrice > e200Now && price <= e200Now)) add("5m", "EMA200 Teması", `EMA200 ${e200Now.toPrecision(7)} teması/geçişi`, price >= e200Now ? "up" : "down");
    }

    for (const [tf, candles] of [["5m", c5], ["15m", c15], ["1h", c60]] as const) {
      const value = lastRsi(candles.map((c) => c.close));
      if (value >= 70) add(tf, "RSI Aşırı Alım", `RSI ${value.toFixed(1)} — 70 üzeri`, "down", value);
      if (value <= 30) add(tf, "RSI Aşırı Satım", `RSI ${value.toFixed(1)} — 30 altı`, "up", value);
    }
    return out;
  })).flat();

  return { ok: true, updatedAt: eventTime(), events };
}

type AuthUser = {
  id: number;
  email: string;
  display_name: string;
  role: "admin" | "member";
  status: "pending" | "approved" | "rejected" | "suspended";
};

const SESSION_COOKIE = "sihirbaz_session";
const SESSION_DAYS = 14;
const PBKDF2_ITERATIONS = 210_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToBase64(new Uint8Array(digest));
}

async function hashPassword(
  password: string,
  saltBase64?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = saltBase64
    ? base64ToBytes(saltBase64)
    : crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );

  return {
    hash: bytesToBase64(new Uint8Array(bits)),
    salt: bytesToBase64(salt),
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left[index] ^ right[index];
  }
  return result === 0;
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator === -1
          ? [part, ""]
          : [
              decodeURIComponent(part.slice(0, separator)),
              decodeURIComponent(part.slice(separator + 1)),
            ];
      }),
  );
}

function sessionCookie(
  request: Request,
  token: string,
  maxAgeSeconds: number,
): string {
  const requestUrl = new URL(request.url);
  const isLocal = requestUrl.hostname === "127.0.0.1" || requestUrl.hostname === "localhost";
  const secure = !isLocal && requestUrl.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(
    token,
  )}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function authJson(
  data: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

async function readSession(
  request: Request,
  env: AppEnv,
): Promise<AuthUser | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;

  const tokenHash = await sha256Base64(token);
  const row = await env.sihirbaz_ai_db
    .prepare(
      `SELECT
         u.id, u.email, u.display_name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<AuthUser>();

  if (!row || row.status !== "approved") return null;

  await env.sihirbaz_ai_db
    .prepare(
      `UPDATE sessions
       SET last_seen_at = CURRENT_TIMESTAMP
       WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .run();

  return row;
}

async function createSession(
  request: Request,
  env: AppEnv,
  userId: number,
): Promise<string> {
  const token = bytesToBase64(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const tokenHash = await sha256Base64(token);
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  await env.sihirbaz_ai_db
    .prepare(
      `INSERT INTO sessions
       (user_id, token_hash, expires_at, user_agent, ip_hint)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      tokenHash,
      expiresAt,
      request.headers.get("user-agent")?.slice(0, 300) || null,
      request.headers.get("cf-connecting-ip")?.slice(0, 64) || null,
    )
    .run();

  return token;
}

async function requireUser(
  request: Request,
  env: AppEnv,
): Promise<AuthUser | Response> {
  const user = await readSession(request, env);
  return user || authJson({ ok: false, error: "Oturum gerekli" }, 401);
}

async function requireAdmin(
  request: Request,
  env: AppEnv,
): Promise<AuthUser | Response> {
  const user = await readSession(request, env);
  if (!user) return authJson({ ok: false, error: "Oturum gerekli" }, 401);
  if (user.role !== "admin") {
    return authJson({ ok: false, error: "Yönetici yetkisi gerekli" }, 403);
  }
  return user;
}

async function audit(
  env: AppEnv,
  actorUserId: number | null,
  action: string,
  targetUserId: number | null,
  metadata: unknown = null,
): Promise<void> {
  await env.sihirbaz_ai_db
    .prepare(
      `INSERT INTO audit_logs
       (actor_user_id, action, target_user_id, metadata_json)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      actorUserId,
      action,
      targetUserId,
      metadata === null ? null : JSON.stringify(metadata),
    )
    .run();
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value: string): boolean {
  return value.length >= 10 && value.length <= 128;
}

async function handleAuthRoutes(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await readSession(request, env);
    return authJson({ ok: true, authenticated: Boolean(user), user });
  }

  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    const body = await request.json<{
      email?: string;
      displayName?: string;
      password?: string;
    }>();

    const email = String(body.email || "").trim().toLowerCase();
    const displayName = String(body.displayName || "").trim().slice(0, 80);
    const password = String(body.password || "");

    if (!validEmail(email)) {
      return authJson({ ok: false, error: "Geçerli e-posta girin" }, 400);
    }
    if (displayName.length < 2) {
      return authJson({ ok: false, error: "Ad en az 2 karakter olmalı" }, 400);
    }
    if (!validPassword(password)) {
      return authJson(
        { ok: false, error: "Şifre en az 10 karakter olmalı" },
        400,
      );
    }

    const existing = await env.sihirbaz_ai_db
      .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
      .bind(email)
      .first<{ id: number }>();

    if (existing) {
      return authJson({ ok: false, error: "Bu e-posta zaten kayıtlı" }, 409);
    }

    const passwordData = await hashPassword(password);
    const result = await env.sihirbaz_ai_db
      .prepare(
        `INSERT INTO users
         (email, display_name, password_hash, password_salt, role, status)
         VALUES (?, ?, ?, ?, 'member', 'pending')`,
      )
      .bind(
        email,
        displayName,
        passwordData.hash,
        passwordData.salt,
      )
      .run();

    await audit(
      env,
      null,
      "user_registered",
      Number(result.meta.last_row_id),
      { email },
    );

    return authJson({
      ok: true,
      status: "pending",
      message: "Başvurunuz yönetici onayına gönderildi.",
    });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await request.json<{ email?: string; password?: string }>();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const user = await env.sihirbaz_ai_db
      .prepare(
        `SELECT id, email, display_name, password_hash, password_salt,
                role, status
         FROM users
         WHERE email = ?
         LIMIT 1`,
      )
      .bind(email)
      .first<
        AuthUser & {
          password_hash: string;
          password_salt: string;
        }
      >();

    if (!user) {
      return authJson({ ok: false, error: "E-posta veya şifre hatalı" }, 401);
    }

    const calculated = await hashPassword(password, user.password_salt);
    if (!constantTimeEqual(calculated.hash, user.password_hash)) {
      return authJson({ ok: false, error: "E-posta veya şifre hatalı" }, 401);
    }

    if (user.status === "pending") {
      return authJson(
        { ok: false, error: "Üyeliğiniz yönetici onayı bekliyor" },
        403,
      );
    }
    if (user.status !== "approved") {
      return authJson(
        { ok: false, error: "Hesabınız erişime kapalı" },
        403,
      );
    }

    const token = await createSession(request, env, user.id);
    await env.sihirbaz_ai_db
      .prepare(
        `UPDATE users
         SET last_login_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(user.id)
      .run();

    await audit(env, user.id, "login", user.id);

    return authJson(
      {
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          role: user.role,
          status: user.status,
        },
      },
      200,
      {
        "set-cookie": sessionCookie(
          request,
          token,
          SESSION_DAYS * 24 * 60 * 60,
        ),
      },
    );
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) {
      const tokenHash = await sha256Base64(token);
      await env.sihirbaz_ai_db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(tokenHash)
        .run();
    }
    return authJson(
      { ok: true },
      200,
      { "set-cookie": sessionCookie(request, "", 0) },
    );
  }

  if (
    url.pathname === "/api/auth/bootstrap-admin" &&
    request.method === "POST"
  ) {
    const supplied = request.headers.get("x-setup-token") || "";
    if (!env.ADMIN_SETUP_TOKEN || supplied !== env.ADMIN_SETUP_TOKEN) {
      return authJson({ ok: false, error: "Kurulum anahtarı hatalı" }, 403);
    }

    const countRow = await env.sihirbaz_ai_db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
      .first<{ count: number }>();

    if ((countRow?.count || 0) > 0) {
      return authJson({ ok: false, error: "Yönetici zaten oluşturulmuş" }, 409);
    }

    const body = await request.json<{
      email?: string;
      displayName?: string;
      password?: string;
    }>();
    const email = String(body.email || "").trim().toLowerCase();
    const displayName = String(body.displayName || "").trim().slice(0, 80);
    const password = String(body.password || "");

    if (!validEmail(email) || displayName.length < 2 || !validPassword(password)) {
      return authJson({ ok: false, error: "Yönetici bilgileri geçersiz" }, 400);
    }

    const passwordData = await hashPassword(password);
    const result = await env.sihirbaz_ai_db
      .prepare(
        `INSERT INTO users
         (email, display_name, password_hash, password_salt,
          role, status, approved_at)
         VALUES (?, ?, ?, ?, 'admin', 'approved', CURRENT_TIMESTAMP)`,
      )
      .bind(email, displayName, passwordData.hash, passwordData.salt)
      .run();

    await audit(
      env,
      Number(result.meta.last_row_id),
      "admin_bootstrapped",
      Number(result.meta.last_row_id),
    );

    return authJson({ ok: true, message: "İlk yönetici oluşturuldu" });
  }

  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return admin;

    const result = await env.sihirbaz_ai_db
      .prepare(
        `SELECT id, email, display_name, role, status,
                created_at, approved_at, last_login_at
         FROM users
         ORDER BY
           CASE status WHEN 'pending' THEN 0 ELSE 1 END,
           created_at DESC
         LIMIT 500`,
      )
      .all();

    return authJson({ ok: true, users: result.results });
  }

  if (
    url.pathname.startsWith("/api/admin/users/") &&
    request.method === "PATCH"
  ) {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return admin;

    const targetId = Number(url.pathname.split("/").at(-1));
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return authJson({ ok: false, error: "Kullanıcı ID geçersiz" }, 400);
    }

    const body = await request.json<{
      status?: "pending" | "approved" | "rejected" | "suspended";
      role?: "admin" | "member";
    }>();

    if (targetId === admin.id && body.status && body.status !== "approved") {
      return authJson(
        { ok: false, error: "Kendi yönetici hesabınızı kapatamazsınız" },
        400,
      );
    }

    if (body.status) {
      await env.sihirbaz_ai_db
        .prepare(
          `UPDATE users
           SET status = ?,
               approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
               approved_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE approved_at END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(
          body.status,
          body.status,
          admin.id,
          body.status,
          targetId,
        )
        .run();

      if (body.status !== "approved") {
        await env.sihirbaz_ai_db
          .prepare("DELETE FROM sessions WHERE user_id = ?")
          .bind(targetId)
          .run();
      }
    }

    if (body.role) {
      await env.sihirbaz_ai_db
        .prepare(
          `UPDATE users
           SET role = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(body.role, targetId)
        .run();
    }

    await audit(env, admin.id, "user_updated", targetId, body);
    return authJson({ ok: true });
  }

  return null;
}

function isProtectedApi(pathname: string): boolean {
  return (
    pathname === "/api/dashboard" ||
    pathname === "/api/coin" ||
    pathname === "/api/ai-comment" ||
    pathname === "/api/ai-packet" ||
    pathname === "/api/mexc-proxy" ||
    pathname === "/api/radar"
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    const authResponse = await handleAuthRoutes(request, env, url);
    if (authResponse) return authResponse;

    if (isProtectedApi(url.pathname)) {
      const user = await requireUser(request, env);
      if (user instanceof Response) return user;
    }


    if (url.pathname === "/api/radar") {
      try {
        return json(await getMarketRadar());
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : "Radar verisi alınamadı" }, 502);
      }
    }

    if (url.pathname === "/api/dashboard") {
      try {
        return json(await getDashboard());
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

    if (url.pathname === "/api/coin") {
      try {
        const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
        if (!symbol) {
          return json({ ok: false, error: "symbol parametresi gerekli" }, 400);
        }
        return json(await getCoinDetail(symbol));
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : "Bilinmeyen hata",
          },
          502,
        );
      }
    }

    if (url.pathname === "/api/ai-comment") {
      try {
        const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
        if (!symbol) {
          return json({ ok: false, error: "symbol parametresi gerekli" }, 400);
        }

        const detail = await getCoinDetail(symbol);
        const ai = await getAiComment(env, detail);

        return json({
          ok: true,
          symbol,
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          comment: ai.comment,
          decision: ai.decision,
          agreement: ai.agreement,
          ruleEngine: {
            side: detail.side,
            score: detail.score,
            ready: detail.ready,
          },
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Yapay zekâ yorumu oluşturulamadı",
          },
          502,
        );
      }
    }

    if (url.pathname === "/api/mexc-proxy") {
      try {
        const path = url.searchParams.get("path") || "";
        return await fetchMexcPublic(path);
      } catch (error) {
        return json(
          {
            ok: false,
            error:
              error instanceof Error
                ? `MEXC bağlantısı başarısız: ${error.message}`
                : "MEXC bağlantısı başarısız",
          },
          502,
        );
      }
    }

    if (url.pathname === "/api/ai-packet" && request.method === "POST") {
      try {
        const packet = await request.json<{
          symbol: string;
          exchange: string;
          marketPacket: unknown;
        }>();

        if (!packet?.symbol || !packet?.marketPacket) {
          return json({ ok: false, error: "Geçersiz AI veri paketi" }, 400);
        }

        const prompt = `
Sen bağımsız çalışan profesyonel bir kripto vadeli işlem piyasa okuyucususun.

Görevin:
- Ham 5m ve 15m OHLCV mumlarını, destek/direnç seviyelerini, kapanış kırılımlarını,
  24 saatlik değişimi, funding ve açık ilgiyi birlikte değerlendir.
- Tek başına negatif funding nedeniyle LONG deme.
- Tek başına büyük düşüş nedeniyle SHORT deme.
- Fiyat sert düşmüşse düşüşü kovalamak yerine retest/tepki riskini hesaba kat.
- Piyasa yönü ile hemen işlem açma kararını birbirinden ayır.
- Hazır teknik skor veya kural motoru sonucu sana verilmemiştir.
- Kesin kazanç veya garanti verme.
- Çıktıyı yalnızca istenen JSON şemasında üret.

Coin: ${packet.symbol}
Borsa: ${packet.exchange}
Ham piyasa paketi:
${JSON.stringify(packet.marketPacket)}
`;

        const result = await env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "Ham piyasa yapısından bağımsız yön ve işlem yaklaşımı üreten ihtiyatlı bir trader gibi davran.",
              },
              { role: "user", content: prompt },
            ],
            response_format: {
              type: "json_schema",
              json_schema: traderAiSchema(),
            },
            max_tokens: 520,
            temperature: 0.2,
          },
        );

        const rawAi = parseTraderAiResult(result);
        const ai = enforceTraderConsistency(rawAi, packet.marketPacket);

        return json({
          ok: true,
          symbol: packet.symbol,
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          marketDirection: ai.market_direction,
          tradeAction: ai.trade_action,
          risk: ai.risk,
          confidence: ai.confidence,
          entryCondition: ai.entry_condition,
          invalidation: ai.invalidation,
          rationale: ai.rationale,
          warning: ai.warning,
          comment: formatTraderComment(ai),
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error:
              error instanceof Error
                ? `AI karar motoru hatası: ${error.message}`
                : "AI karar motoru hatası",
          },
          502,
        );
      }
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "sihirbaz-ai",
        version: "2.0.0",
        time: new Date().toISOString(),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<AppEnv>;
