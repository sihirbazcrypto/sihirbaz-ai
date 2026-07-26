
type AppEnv = Env & {
  AI: Ai;
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

  const ema35_5 = ema(close5, 35);
  const ema35_15 = ema(close15, 35);
  const ema200_5 = ema(close5, 200);
  const ema200_15 = ema(close15, 200);

  const bb5 = bollingerState(close5);
  const bb15 = bollingerState(close15);
  const atr5 = atrPct(c5);
  const volRatio5 = volumeRatio(c5);

  const longTrendGate =
    last5 > ema35_5 &&
    last15 > ema35_15 &&
    last15 > ema200_15;

  const shortTrendGate =
    last5 < ema35_5 &&
    last15 < ema35_15 &&
    last15 < ema200_15;

  let longScore = 0;
  let shortScore = 0;
  const reasonsLong: string[] = [];
  const reasonsShort: string[] = [];
  const warningsLong: string[] = [];
  const warningsShort: string[] = [];

  if (longTrendGate) {
    longScore += 30;
    reasonsLong.push("5m ve 15m EMA35 üstü, 15m EMA200 üstü");
  } else {
    warningsLong.push("Long trend filtresi eksik");
  }

  if (shortTrendGate) {
    shortScore += 30;
    reasonsShort.push("5m ve 15m EMA35 altı, 15m EMA200 altı");
  } else {
    warningsShort.push("Short trend filtresi eksik");
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
    emaSide5: last5 >= ema35_5 ? "above" : "below",
    emaSide15: last15 >= ema35_15 ? "above" : "below",
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

async function getKlines(symbol: string, interval: "5" | "15"): Promise<Candle[]> {
  const result = await bybitFetch<KlineResult>(
    `/v5/market/kline?category=linear&symbol=${encodeURIComponent(
      symbol,
    )}&interval=${interval}&limit=${KLINE_LIMIT}`,
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
    version: "0.6.0",
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
    version: "0.6.0",
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
    candles5: c5.slice(-100),
    indicators5: {
      ema35: emaSeries(c5.map((c) => c.close), 35).slice(-100),
      ema200: emaSeries(c5.map((c) => c.close), 200).slice(-100),
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
    updatedAtDisplay: new Date().toLocaleTimeString("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}

async function getAiComment(
  env: AppEnv,
  detail: Awaited<ReturnType<typeof getCoinDetail>>,
): Promise<string> {
  const sideText = detail.side === "long" ? "LONG" : "SHORT";

  const prompt = `
Sen Sihirbaz AI adlı kripto vadeli işlem analiz asistanısın.
Yalnızca verilen sayısal ve teknik verilere dayan.
Kesin kazanç, başarı yüzdesi veya garanti verme.
Kısa, açık ve Türkçe yaz. En fazla 130 kelime kullan.

Coin: ${detail.symbol}
Borsa: Bybit Futures
Tercih edilen yön: ${sideText}
Skor: ${detail.score}/100
Durum: ${detail.ready ? "HAZIR" : "İZLE"}
Risk: ${detail.risk}
24 saat değişim: ${detail.change.toFixed(2)}%
RSI5: ${detail.analysis.rsi5.toFixed(1)}
RSI15: ${detail.analysis.rsi15.toFixed(1)}
Stoch RSI 5m K/D: ${detail.analysis.stoch5.k.toFixed(0)}/${detail.analysis.stoch5.d.toFixed(0)}
Stoch RSI 15m K/D: ${detail.analysis.stoch15.k.toFixed(0)}/${detail.analysis.stoch15.d.toFixed(0)}
EMA35 5m: ${detail.analysis.emaSide5}
EMA35 15m: ${detail.analysis.emaSide15}
EMA200 15m: ${detail.analysis.ema200Side15}
Bollinger 5m: ${detail.analysis.bb5}
Hacim oranı: ${detail.analysis.volumeRatio5.toFixed(2)}x
ATR: ${detail.analysis.atrPct5.toFixed(2)}%
Funding: ${detail.fundingRate.toFixed(4)}%
Open Interest: ${detail.openInterestValue}
Olumlu nedenler: ${detail.reasons.join("; ") || "Yok"}
Uyarılar: ${detail.warnings.join("; ") || "Yok"}

Şu sırayla cevapla:
1. Genel değerlendirme
2. Girişi destekleyen veya engelleyen ana neden
3. En önemli risk
4. "Sonuç:" ile başlayan tek cümlelik karar: HAZIR, GERİ ÇEKİLME BEKLE veya UZAK DUR.
`;

  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content:
          "Sen açıklanabilir teknik analiz yapan ihtiyatlı bir kripto piyasa asistanısın.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 260,
    temperature: 0.25,
  });

  return safeAiText(result);
}


export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

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
        const comment = await getAiComment(env, detail);

        return json({
          ok: true,
          symbol,
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          comment,
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

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "sihirbaz-ai",
        version: "0.6.0",
        time: new Date().toISOString(),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<AppEnv>;

