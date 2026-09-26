import type { Candle } from "@/modules/exchanges/types";
import { clamp } from "@/shared/utils";

/**
 * Indicator Engine — pure functions over candle closes.
 * Each indicator returns an array aligned to the input candles
 * (leading values may be NaN until the window fills).
 */

export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    if (i >= period - 1) out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = Math.max(diff, 0);
    const l = Math.max(-diff, 0);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        gain /= period;
        loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MacdResult {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const macdLine = closes.map((_, i) =>
    Number.isNaN(fast[i]) || Number.isNaN(slow[i]) ? NaN : fast[i] - slow[i],
  );
  const valid = macdLine.filter((v) => !Number.isNaN(v));
  const sigValid = ema(valid, signalPeriod);
  const signal = new Array(closes.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (!Number.isNaN(macdLine[i])) {
      signal[i] = sigValid[j] ?? NaN;
      j++;
    }
  }
  const histogram = macdLine.map((v, i) =>
    Number.isNaN(v) || Number.isNaN(signal[i]) ? NaN : v - signal[i],
  );
  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  pctB: number[]; // %B position 0..1
}

export function bollinger(closes: number[], period = 20, stdDev = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);
  const pctB: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let k = i - period + 1; k <= i; k++) sumSq += (closes[k] - middle[i]) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + stdDev * sd;
    lower[i] = middle[i] - stdDev * sd;
    const range = upper[i] - lower[i];
    pctB[i] = range === 0 ? 0.5 : (closes[i] - lower[i]) / range;
  }
  return { upper, middle, lower, pctB };
}

// ---- Phase-2 indicators ---------------------------------------------------

/**
 * VWAP — cumulative volume-weighted average price, reset each UTC day.
 * Output aligned to candles (NaN never — defined from first candle).
 */
export function vwap(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  let cumPV = 0;
  let cumV = 0;
  let day = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.time / 86_400_000);
    if (d !== day) { day = d; cumPV = 0; cumV = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    out[i] = cumV > 0 ? cumPV / cumV : typical;
  }
  return out;
}

/** ATR — Average True Range (Wilder smoothing). For dynamic SL/TP, not signals. */
export function atr(candles: Candle[], period = 14): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length === 0) return out;
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const pc = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i < period) {
      sum += tr;
      if (i === period - 1) { prev = sum / period; out[i] = prev; }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

export interface StochasticResult {
  /** %K — smoothed fast stochastic (0..100) */
  k: number[];
  /** %D — signal line, SMA of %K (0..100) */
  d: number[];
}

/** Stochastic Oscillator — scalping defaults 5/3/3 (kPeriod, dPeriod, smoothing). */
export function stochastic(candles: Candle[], kPeriod = 5, dPeriod = 3, smoothing = 3): StochasticResult {
  const n = candles.length;
  const rawK: number[] = new Array(n).fill(NaN);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    rawK[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const sm = (arr: number[], p: number): number[] => {
    const o: number[] = new Array(n).fill(NaN);
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (Number.isFinite(v)) { sum += v; cnt++; }
      if (i >= p && Number.isFinite(arr[i - p])) { sum -= arr[i - p]; cnt--; }
      if (i >= p - 1 && cnt > 0) o[i] = sum / cnt;
    }
    return o;
  };
  const k = sm(rawK, smoothing);
  return { k, d: sm(k, dPeriod) };
}

/** OBV — On-Balance Volume. Rising OBV confirms uptrend. */
export function obv(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(NaN);
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      if (candles[i].close > candles[i - 1].close) acc += candles[i].volume;
      else if (candles[i].close < candles[i - 1].close) acc -= candles[i].volume;
    }
    out[i] = acc;
  }
  return out;
}

// ---- Indicator dispatch ---------------------------------------------------

export interface IndicatorParams {
  period?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  stdDev?: number;
  kPeriod?: number;
  dPeriod?: number;
  smoothing?: number;
  /** ATR risk multipliers */
  slMultiplier?: number;
  tpMultiplier?: number;
}

export interface IndicatorSeries {
  name: string;
  /** primary series (rsi value, ma value, histogram, pctB) */
  values: number[];
  /** secondary series for crossovers (e.g. macd signal line, ma line for price crosses) */
  secondary?: number[];
}

/** Indicators that never contribute to the weighted signal score (risk tooling). */
export const NON_SCORING = new Set(["ATR"]);

export function computeIndicator(
  name: string,
  params: IndicatorParams,
  candles: Candle[],
): IndicatorSeries {
  const closes = candles.map((c) => c.close);
  switch (name.toUpperCase()) {
    case "RSI":
      return { name, values: rsi(closes, params.period ?? 14) };
    case "EMA": {
      const v = ema(closes, params.period ?? 20);
      return { name, values: v, secondary: closes };
    }
    case "SMA": {
      const v = sma(closes, params.period ?? 20);
      return { name, values: v, secondary: closes };
    }
    case "MACD": {
      const m = macd(closes, params.fastPeriod ?? 12, params.slowPeriod ?? 26, params.signalPeriod ?? 9);
      return { name, values: m.histogram, secondary: m.signal };
    }
    case "BOLLINGER": {
      const b = bollinger(closes, params.period ?? 20, params.stdDev ?? 2);
      return { name, values: b.pctB, secondary: closes };
    }
    case "VWAP": {
      const v = vwap(candles);
      return { name, values: v, secondary: closes };
    }
    case "STOCHASTIC": {
      const s = stochastic(candles, params.kPeriod ?? 5, params.dPeriod ?? 3, params.smoothing ?? 3);
      return { name, values: s.k, secondary: s.d };
    }
    case "OBV": {
      const o = obv(candles);
      return { name, values: o, secondary: sma(o, params.period ?? 20) };
    }
    case "ATR": {
      return { name, values: atr(candles, params.period ?? 14) };
    }
    default:
      throw new Error(`Unknown indicator: ${name}`);
  }
}

// ---- Condition DSL ----------------------------------------------------------

/**
 * Condition JSON DSL — evaluated against the indicator's latest values.
 * { "op": "lt"|"gt"|"lte"|"gte"|"eq"|"between"|"cross_above"|"cross_below",
 *   "value": 30, "a": 0.2, "b": 0.8, "target": "price"|"secondary" }
 */
export interface Condition {
  op: "lt" | "gt" | "lte" | "gte" | "eq" | "between" | "cross_above" | "cross_below";
  value?: number;
  a?: number;
  b?: number;
  target?: "price" | "secondary";
}

export function evaluateCondition(cond: Condition, series: IndicatorSeries, closes: number[], index?: number): boolean {
  const i = index ?? closes.length - 1;
  const value = cond.target === "price" ? closes[i] : series.values[i];
  const prevValue = cond.target === "price" ? closes[i - 1] : series.values[i - 1];
  // reference line: indicator value when comparing price, else the secondary series (signal line, %D, closes for MA)
  const ref = cond.target === "price" ? series.values[i] : series.secondary?.[i];
  const prevRef = cond.target === "price" ? series.values[i - 1] : series.secondary?.[i - 1];

  switch (cond.op) {
    case "lt": return value < (cond.value ?? 0);
    case "lte": return value <= (cond.value ?? 0);
    case "gt": return value > (cond.value ?? 0);
    case "gte": return value >= (cond.value ?? 0);
    case "eq": return value === cond.value;
    case "between": return value >= (cond.a ?? -Infinity) && value <= (cond.b ?? Infinity);
    case "cross_above":
      if (ref === undefined || prevRef === undefined) return false;
      return prevValue <= prevRef && value > ref;
    case "cross_below":
      if (ref === undefined || prevRef === undefined) return false;
      return prevValue >= prevRef && value < ref;
    default: return false;
  }
}

/**
 * Default continuous score when no explicit condition matches —
 * normalizes the indicator into [-1, +1] where +1 = strong buy.
 */
export function defaultScore(name: string, series: IndicatorSeries, closes: number[], index?: number): number {
  const i = index ?? closes.length - 1;
  const v = series.values[i];
  const price = closes[i];
  if (Number.isNaN(v)) return 0;

  switch (name.toUpperCase()) {
    case "RSI":
      return clamp((50 - v) / 50, -1, 1); // rsi<50 → positive
    case "EMA":
    case "SMA": {
      if (!price) return 0;
      return clamp(((price - v) / price) * 10, -1, 1); // price above MA → positive
    }
    case "MACD": {
      const hist = v;
      const scale = Math.abs(price) * 0.001 || 1;
      return clamp(hist / scale, -1, 1);
    }
    case "BOLLINGER":
      return clamp((0.5 - v) * 2, -1, 1); // near lower band → positive
    case "VWAP": {
      if (!price) return 0;
      return clamp(((price - v) / price) * 15, -1, 1); // price above VWAP → bullish
    }
    case "STOCHASTIC":
      return clamp((50 - v) / 50, -1, 1); // oversold → positive
    case "OBV": {
      const base = series.secondary?.[i];
      if (!base || !Number.isFinite(base)) return 0;
      return clamp((v - base) / Math.abs(base), -1, 1);
    }
    case "ATR":
      return 0; // risk tool — never contributes to the signal score
    default:
      return 0;
  }
}
