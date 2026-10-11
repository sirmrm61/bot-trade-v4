import type { Candle } from "@/modules/exchanges/types";
import { rsi, ema, sma, atr } from "@/modules/indicators/engine";
import { resample } from "@/modules/signals/quality";

/**
 * Feature extraction for the forecast model.
 *
 * STRICT no-lookahead contract: `featureVectorAt(candles, i, ctx)` reads only
 * candles[0..i] — indicator arrays are computed once over the full series for
 * speed, but each element at index i is by definition computable from data up
 * to and including candle i (EMA/RSI/ATR recursions are causal).
 *
 * Market context (BTC) is passed as a time→close map built the same causal
 * way; alignment uses the latest BTC close at-or-before candle i's time.
 */

export const FEATURE_NAMES = [
  "ret1", "ret4", "ret16", "ret48",       // multi-horizon log returns
  "distEma20", "distEma50",               // (close-ema)/close %
  "rsi14",
  "atrPct", "atrRatio",                   // ATR% and ATR / its 20-SMA (vol change)
  "volZ",                                 // volume z-score (20 candles)
  "htfTrend",                             // EMA20 slope on 4x resampled closes
  "distSwingHiAtr", "distSwingLoAtr",     // room to S/R in ATR units
  "hourSin", "hourCos",                   // time-of-day cyclical
  "btcTrend", "btcCorr",                  // market context
] as const;

export type FeatureVector = number[];

export interface FeatureContext {
  /** BTC closes of the SAME timeframe, sorted ascending by time */
  btcCloses?: { time: number; close: number }[];
  /** BTC log-return series aligned to btcCloses (precomputed, causal) */
  btcReturns?: number[];
}

interface Precomputed {
  closes: number[];
  highs: number[];
  lows: number[];
  vols: number[];
  ema20: number[];
  ema50: number[];
  rsi14: number[];
  atr14: number[];
  atrSma20: number[];
  volMean20: number[];
  volStd20: number[];
  htfEma20: number[];   // EMA20 of 4x-resampled closes, mapped back per index
  swingHi96: number[];
  swingLo96: number[];
}

export function precompute(candles: Candle[]): Precomputed {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume);
  const n = candles.length;

  const atr14 = atr(candles, 14);
  const atrSma20 = sma(atr14.map((v) => (Number.isFinite(v) ? v : 0)), 20);

  // rolling volume mean/std (window 20, causal)
  const volMean20 = new Array<number>(n).fill(NaN);
  const volStd20 = new Array<number>(n).fill(NaN);
  for (let i = 19; i < n; i++) {
    let s = 0, sq = 0;
    for (let j = i - 19; j <= i; j++) { s += vols[j]; sq += vols[j] * vols[j]; }
    const m = s / 20;
    volMean20[i] = m;
    volStd20[i] = Math.sqrt(Math.max(sq / 20 - m * m, 0));
  }

  // 4x-resampled EMA20 mapped back: candle i takes the htf ema of the latest
  // completed 4x group ending at-or-before i (no lookahead within the group —
  // the group must be COMPLETE, so we align to floor(i/4)*4-1 groups)
  const htfEma20 = new Array<number>(n).fill(NaN);
  const htfCloses: number[] = [];
  const htfEma: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((i + 1) % 4 === 0) {
      htfCloses.push(closes[i]);
      const e = ema(htfCloses, 20);
      htfEma.push(e.at(-1)!);
    }
    const g = Math.floor((i + 1) / 4) - 1;
    if (g >= 0) htfEma20[i] = htfEma[g] ?? NaN;
  }

  // rolling swing hi/lo (96 candles, causal)
  const swingHi96 = new Array<number>(n).fill(NaN);
  const swingLo96 = new Array<number>(n).fill(NaN);
  for (let i = 95; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 95; j <= i; j++) { if (highs[j] > hi) hi = highs[j]; if (lows[j] < lo) lo = lows[j]; }
    swingHi96[i] = hi; swingLo96[i] = lo;
  }

  return {
    closes, highs, lows, vols,
    ema20: ema(closes, 20), ema50: ema(closes, 50), rsi14: rsi(closes, 14),
    atr14, atrSma20, volMean20, volStd20, htfEma20, swingHi96, swingLo96,
  };
}

const ret = (closes: number[], i: number, k: number) =>
  i >= k && closes[i - k] > 0 ? Math.log(closes[i] / closes[i - k]) : 0;

/** latest BTC log-return index at-or-before time t (binary search) */
function btcIndexAt(btc: { time: number }[], t: number): number {
  let lo = 0, hi = btc.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (btc[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function featureVectorAt(
  candles: Candle[],
  pre: Precomputed,
  i: number,
  ctx: FeatureContext = {},
): FeatureVector | null {
  const { closes, vols } = pre;
  const price = closes[i];
  if (!Number.isFinite(price) || price <= 0 || i < 96) return null; // need warmup

  const atrNow = pre.atr14[i];
  const atrPct = Number.isFinite(atrNow) ? (atrNow / price) * 100 : 0;
  const atrRatio = Number.isFinite(pre.atrSma20[i]) && pre.atrSma20[i] > 0
    ? atrNow / pre.atrSma20[i] : 1;

  const volZ = Number.isFinite(pre.volStd20[i]) && pre.volStd20[i] > 0
    ? (vols[i] - pre.volMean20[i]) / pre.volStd20[i]
    : 0;

  // htf trend: normalized slope of the 4x EMA20 — compare current htf ema to
  // the value 4 htf bars ago (16 candles back), expressed in % of price
  const iPrev = Math.max(0, i - 16);
  const htfTrend = Number.isFinite(pre.htfEma20[i]) && Number.isFinite(pre.htfEma20[iPrev]) && pre.htfEma20[iPrev] > 0
    ? Math.tanh(((pre.htfEma20[i] - pre.htfEma20[iPrev]) / pre.htfEma20[iPrev]) * 100)
    : 0;

  const distHi = Number.isFinite(atrNow) && atrNow > 0 && Number.isFinite(pre.swingHi96[i])
    ? (pre.swingHi96[i] - price) / atrNow : 0;
  const distLo = Number.isFinite(atrNow) && atrNow > 0 && Number.isFinite(pre.swingLo96[i])
    ? (price - pre.swingLo96[i]) / atrNow : 0;

  const hour = new Date(candles[i].time).getUTCHours() + new Date(candles[i].time).getUTCMinutes() / 60;
  const ang = (hour / 24) * 2 * Math.PI;

  // BTC context
  let btcTrend = 0, btcCorr = 0;
  const btc = ctx.btcCloses;
  if (btc && btc.length > 50) {
    const bi = btcIndexAt(btc, candles[i].time);
    if (bi >= 48) {
      btcTrend = Math.tanh(Math.log(btc[bi].close / btc[bi - 48].close) * 100);
      // rolling correlation of the last 48 log returns
      const retsA: number[] = [], retsB: number[] = [];
      for (let j = bi - 47; j <= bi && j >= 1; j++) {
        const t = btc[j].time;
        const ai = candleIndexAtOrBefore(candles, t);
        if (ai >= 1) {
          retsA.push(Math.log(closes[ai] / closes[ai - 1]));
          retsB.push(Math.log(btc[j].close / btc[j - 1].close));
        }
      }
      btcCorr = retsA.length >= 24 ? pearson(retsA, retsB) : 0;
    }
  }

  return [
    ret(closes, i, 1) * 100, ret(closes, i, 4) * 100, ret(closes, i, 16) * 100, ret(closes, i, 48) * 100,
    pct(pre.ema20[i], price), pct(pre.ema50[i], price),
    Number.isFinite(pre.rsi14[i]) ? pre.rsi14[i] : 50,
    atrPct, atrRatio,
    Math.max(-5, Math.min(5, volZ)),
    htfTrend,
    Math.max(-10, Math.min(10, distHi)), Math.max(-10, Math.min(10, distLo)),
    Math.sin(ang), Math.cos(ang),
    btcTrend, btcCorr,
  ];
}

const pct = (ma: number, price: number) =>
  Number.isFinite(ma) && price > 0 ? ((price - ma) / price) * 100 : 0;

function candleIndexAtOrBefore(candles: { time: number }[], t: number): number {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/** convenience: latest feature vector for inference */
export function latestFeatures(candles: Candle[], ctx: FeatureContext = {}): FeatureVector | null {
  const pre = precompute(candles);
  return featureVectorAt(candles, pre, candles.length - 1, ctx);
}

export { resample };
