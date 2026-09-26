import type { Candle } from "@/modules/exchanges/types";
import { clamp, parseJson } from "@/shared/utils";
import { ema, sma } from "@/modules/indicators/engine";
import type {
  AtmSmeConfigInput,
  RmmBseConfigInput,
  DzsHmmConfigInput,
} from "@/modules/strategies/service";

/**
 * Symbolic Signal Engines — three candle-native engines from the
 * "سه موتور سمبلیک سیگنال‌دهی" spec. Each discretizes market data into
 * tokens/regimes, then emits BUY/SELL/HOLD per candle index.
 *
 * Signals are evaluated on CLOSED candles — the backtest engine executes
 * on the next candle (executionDelay), matching the spec.
 */

export const SYMBOLIC_KINDS = ["ATM_SME", "RMM_BSE", "DZS_HMM"] as const;
export type SymbolicKind = (typeof SYMBOLIC_KINDS)[number];

export function isSymbolicKind(kind: string): kind is SymbolicKind {
  return (SYMBOLIC_KINDS as readonly string[]).includes(kind);
}

const EPS = 1e-8;
type Signal = "BUY" | "SELL" | "HOLD";

// ============================================================================
// Config readers — user-tunable parameters with doc defaults
// ============================================================================

export interface AtmSmeConfig {
  volWindow: number;          // σt window of past returns (default 20)
  gamma: number;              // sensitivity coefficient γ (default 1.5)
  tokenMid: number;           // |V| boundary for B/D zone (default 0.20)
  tokenExtreme: number;       // |V| boundary for A/E zone (default 0.60)
  emaPeriod: number;          // confirmation EMA (default 9)
  useEmaConfirm: boolean;     // require close vs EMA confirm (default true)
  recoverVt: number;          // long: Vt must recover above this (default -0.15)
  weakenVt: number;           // short/exit: Vt must weaken below this (default +0.15)
  minPatternWinRate: number;  // historical hit-rate gate 0..1 (default 0.65; 0 = off)
  minPatternCount: number;    // min past occurrences for the gate (default 3)
  probWindow: number;         // lookback candles for pattern stats (default 300)
  exitTrigger: number;        // momentum-decay: peak Vt (default +0.70)
  exitBack: number;           // momentum-decay: fall back below (default +0.40)
  decayLookback: number;      // candles to look back for the peak (default 10)
}

export interface RmmBseConfig {
  channelLen: number;         // k — prior candles forming the channel (default 20)
  squeezeAbs: number;         // |M| squeeze band (default 0.35)
  squeezeBars: number;        // consecutive squeeze candles required (default 5)
  breakoutMt: number;         // |M| entry zone (default 0.85)
  exitMt: number;             // exit when M falls below (default +0.10)
  useVolumeConfirm: boolean;  // require volume confirmation (default true)
  volMult: number;            // volume ≥ volMult × average (default 1.5)
  volPeriod: number;          // volume average period (default 20)
}

export interface DzsHmmConfig {
  zWindow: number;            // rolling μ/σ window (default 60)
  feature: "return" | "deviation"; // observation Xt (default return)
  emitCenter: number;         // emission center for trend states (default 0.6)
  emitSigma: number;          // emission sigma (default 0.35)
  pStay: number;              // regime persistence prob (default 0.90)
  bullProb: number;           // P(bull) entry threshold (default 0.75)
  sCross: number;             // St upward cross level (default +0.33)
  persist: number;            // candles the prob must persist (default 1)
  rangeProbExit: number;      // exit when P(range) rises above (default 0.60)
  bearProbExit: number;       // exit when P(bear) rises above (default 0.60)
}

export function readAtmSmeConfig(configJson: string): AtmSmeConfig {
  const c = parseJson<{ atmSme?: AtmSmeConfigInput }>(configJson, {}).atmSme ?? {};
  return {
    volWindow: clamp(Math.floor(c.volWindow ?? 20), 2, 500),
    gamma: clamp(c.gamma ?? 1.5, 0.01, 100),
    tokenMid: clamp(c.tokenMid ?? 0.2, 0.01, 0.99),
    tokenExtreme: clamp(c.tokenExtreme ?? 0.6, 0.01, 1),
    emaPeriod: clamp(Math.floor(c.emaPeriod ?? 9), 1, 200),
    useEmaConfirm: c.useEmaConfirm ?? true,
    recoverVt: clamp(c.recoverVt ?? -0.15, -1, 1),
    weakenVt: clamp(c.weakenVt ?? 0.15, -1, 1),
    minPatternWinRate: clamp(c.minPatternWinRate ?? 0.65, 0, 1),
    minPatternCount: clamp(Math.floor(c.minPatternCount ?? 3), 0, 100),
    probWindow: clamp(Math.floor(c.probWindow ?? 300), 10, 5000),
    exitTrigger: clamp(c.exitTrigger ?? 0.7, -1, 1),
    exitBack: clamp(c.exitBack ?? 0.4, -1, 1),
    decayLookback: clamp(Math.floor(c.decayLookback ?? 10), 1, 200),
  };
}

export function readRmmBseConfig(configJson: string): RmmBseConfig {
  const c = parseJson<{ rmmBse?: RmmBseConfigInput }>(configJson, {}).rmmBse ?? {};
  return {
    channelLen: clamp(Math.floor(c.channelLen ?? 20), 2, 500),
    squeezeAbs: clamp(c.squeezeAbs ?? 0.35, 0.01, 1),
    squeezeBars: clamp(Math.floor(c.squeezeBars ?? 5), 1, 100),
    breakoutMt: clamp(c.breakoutMt ?? 0.85, 0.01, 1),
    exitMt: clamp(c.exitMt ?? 0.1, -1, 1),
    useVolumeConfirm: c.useVolumeConfirm ?? true,
    volMult: clamp(c.volMult ?? 1.5, 0.1, 100),
    volPeriod: clamp(Math.floor(c.volPeriod ?? 20), 1, 500),
  };
}

export function readDzsHmmConfig(configJson: string): DzsHmmConfig {
  const c = parseJson<{ dzsHmm?: DzsHmmConfigInput }>(configJson, {}).dzsHmm ?? {};
  return {
    zWindow: clamp(Math.floor(c.zWindow ?? 60), 5, 1000),
    feature: c.feature === "deviation" ? "deviation" : "return",
    emitCenter: clamp(c.emitCenter ?? 0.6, 0.05, 1),
    emitSigma: clamp(c.emitSigma ?? 0.35, 0.01, 2),
    pStay: clamp(c.pStay ?? 0.9, 0.5, 0.999),
    bullProb: clamp(c.bullProb ?? 0.75, 0.5, 0.99),
    sCross: clamp(c.sCross ?? 0.33, 0.01, 1),
    persist: clamp(Math.floor(c.persist ?? 1), 1, 20),
    rangeProbExit: clamp(c.rangeProbExit ?? 0.6, 0.1, 0.99),
    bearProbExit: clamp(c.bearProbExit ?? 0.6, 0.1, 0.99),
  };
}

// ============================================================================
// helpers
// ============================================================================

function logReturns(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0 && candles[i].close > 0) out[i] = Math.log(candles[i].close / prev);
  }
  return out;
}

/** std of the `win` values ending EXCLUSIVELY before index i (past data only). */
function rollingStd(vals: number[], i: number, win: number): number {
  if (i < win) return NaN;
  let sum = 0;
  let n = 0;
  for (let j = i - win; j < i; j++) {
    const v = vals[j];
    if (!Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  if (n < 2) return NaN;
  const mean = sum / n;
  let sq = 0;
  for (let j = i - win; j < i; j++) {
    const v = vals[j];
    if (Number.isFinite(v)) sq += (v - mean) * (v - mean);
  }
  return Math.sqrt(sq / n);
}

// ============================================================================
// 1) ATM-SME — adaptive tanh-momentum symbolic engine
// ============================================================================

export type AtmToken = "A" | "B" | "C" | "D" | "E";

/** Vt = tanh( rt / (γ·σt + ε) ) — volatility-adjusted momentum ∈ [-1,1]. */
export function atmSmeSeries(candles: Candle[], cfg: AtmSmeConfig): number[] {
  const rets = logReturns(candles);
  const v = new Array<number>(candles.length).fill(NaN);
  for (let i = 1; i < candles.length; i++) {
    const sd = rollingStd(rets, i, cfg.volWindow);
    if (!Number.isFinite(sd)) continue;
    v[i] = Math.tanh(rets[i] / (cfg.gamma * sd + EPS));
  }
  return v;
}

export function atmToken(v: number, cfg: AtmSmeConfig): AtmToken | null {
  if (!Number.isFinite(v)) return null;
  if (v >= cfg.tokenExtreme) return "A";
  if (v >= cfg.tokenMid) return "B";
  if (v >= -cfg.tokenMid) return "C";
  if (v >= -cfg.tokenExtreme) return "D";
  return "E";
}

const LONG_PATTERNS: string[] = ["EEC", "EED"];
const SHORT_PATTERNS: string[] = ["AAC", "AAB"];

/**
 * Historical hit-rate of a 3-token pattern over the last `probWindow`
 * candles — fraction of occurrences followed by a positive (`dir="up"`)
 * or negative next-candle move. Outcome candles must be closed, so only
 * patterns ending at j ≤ i-2 count.
 */
function patternWinRate(
  tokens: (AtmToken | null)[],
  closes: number[],
  i: number,
  cfg: AtmSmeConfig,
  dir: "up" | "down",
): { count: number; rate: number } {
  const pat = tokens.slice(i - 2, i + 1);
  if (pat.some((t) => t === null)) return { count: 0, rate: 0 };
  const key = pat.join("");
  let count = 0;
  let wins = 0;
  const from = Math.max(2, i - cfg.probWindow);
  for (let j = from; j <= i - 2; j++) {
    if (tokens[j - 2] === null || tokens[j - 1] === null || tokens[j] === null) continue;
    if (`${tokens[j - 2]}${tokens[j - 1]}${tokens[j]}` !== key) continue;
    count++;
    const up = closes[j + 1] > closes[j];
    if (dir === "up" ? up : !up) wins++;
  }
  return { count, rate: count > 0 ? wins / count : 0 };
}

export interface AtmSmeState {
  v: number[];
  tokens: (AtmToken | null)[];
  signal: Signal[];
}

export function atmSmeState(candles: Candle[], cfg: AtmSmeConfig): AtmSmeState {
  const v = atmSmeSeries(candles, cfg);
  const tokens = v.map((x) => atmToken(x, cfg));
  const closes = candles.map((c) => c.close);
  const emaSeries = cfg.useEmaConfirm ? ema(closes, cfg.emaPeriod) : null;
  const signal = new Array<Signal>(candles.length).fill("HOLD");

  for (let i = 2; i < candles.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    const pat = `${tokens[i - 2]}${tokens[i - 1]}${tokens[i]}`;

    // long entry — exhaustion pattern + Vt recovery + EMA confirm + history gate.
    // A fresh entry pattern outranks the momentum-decay exit on the same candle
    // (the backtest engine only acts on SELL while holding anyway).
    if (
      LONG_PATTERNS.includes(pat) &&
      v[i] > cfg.recoverVt &&
      (!emaSeries || (Number.isFinite(emaSeries[i]) && closes[i] > emaSeries[i]))
    ) {
      if (cfg.minPatternWinRate > 0) {
        const { count, rate } = patternWinRate(tokens, closes, i, cfg, "up");
        if (count < cfg.minPatternCount || rate < cfg.minPatternWinRate) continue;
      }
      signal[i] = "BUY";
      continue;
    }

    // exits — in spot mode a short pattern means "exit / don't buy"; the
    // momentum-decay rule closes positions after Vt peaks and falls back
    const decayPeak = Math.max(
      ...v.slice(Math.max(0, i - cfg.decayLookback + 1), i + 1).filter(Number.isFinite),
      -Infinity,
    );
    const momentumDecay = decayPeak >= cfg.exitTrigger && v[i] < cfg.exitBack;
    const shortPat =
      SHORT_PATTERNS.includes(pat) &&
      v[i] < cfg.weakenVt &&
      (!emaSeries || (Number.isFinite(emaSeries[i]) && closes[i] < emaSeries[i]));
    if (momentumDecay || shortPat) signal[i] = "SELL";
  }
  return { v, tokens, signal };
}

// ============================================================================
// 2) RMM-BSE — rolling min-max breakout structure engine
// ============================================================================

/** Mt — close position inside the channel of the PRIOR k candles ∈ [-1,1]. */
export function rmmBseSeries(candles: Candle[], cfg: RmmBseConfig): number[] {
  const m = new Array<number>(candles.length).fill(NaN);
  for (let i = cfg.channelLen; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - cfg.channelLen; j < i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    m[i] = clamp((2 * (candles[i].close - ll)) / (hh - ll + EPS) - 1, -1, 1);
  }
  return m;
}

export type RmmLabel = "UP_BREAK" | "MID_BULL" | "SQUEEZE" | "MID_BEAR" | "DN_BREAK";

export function rmmLabel(m: number): RmmLabel | null {
  if (!Number.isFinite(m)) return null;
  if (m >= 0.9) return "UP_BREAK";
  if (m >= 0.2) return "MID_BULL";
  if (m > -0.2) return "SQUEEZE";
  if (m > -0.9) return "MID_BEAR";
  return "DN_BREAK";
}

export interface RmmBseState {
  m: number[];
  signal: Signal[];
}

export function rmmBseState(candles: Candle[], cfg: RmmBseConfig): RmmBseState {
  const m = rmmBseSeries(candles, cfg);
  const volAvg = cfg.useVolumeConfirm ? sma(candles.map((c) => c.volume), cfg.volPeriod) : null;
  const signal = new Array<Signal>(candles.length).fill("HOLD");

  // consecutive |M| ≤ squeezeAbs run-length ending at each index
  const run = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    run[i] = Number.isFinite(m[i]) && Math.abs(m[i]) <= cfg.squeezeAbs ? run[i - 1] + 1 : 0;
  }

  for (let i = cfg.channelLen; i < candles.length; i++) {
    if (!Number.isFinite(m[i])) continue;
    if (m[i] < cfg.exitMt) {
      signal[i] = "SELL"; // trend-follow exit / no-entry
      continue;
    }
    // entry: squeeze before this candle, then close in the breakout zone
    if (run[i - 1] < cfg.squeezeBars || m[i] < cfg.breakoutMt) continue;
    if (volAvg && Number.isFinite(volAvg[i]) && candles[i].volume < cfg.volMult * volAvg[i]) continue;
    signal[i] = "BUY";
  }
  return { m, signal };
}

// ============================================================================
// 3) DZS-HMM — dynamic z-score + hidden-Markov regime filter
// ============================================================================

export interface DzsHmmState {
  s: number[];      // normalized z-score St ∈ [-1,1]
  pRange: number[]; // filtered P(range state)
  pBull: number[];  // filtered P(bull trend state)
  pBear: number[];  // filtered P(bear trend state)
  signal: Signal[];
}

/**
 * Filtered (causal) 3-state HMM: range | bull | bear.
 * Observations St = clip(Zt/3) where Zt z-scores the feature against the
 * past zWindow values; emissions are Gaussian around per-state centers;
 * transitions are a sticky symmetric matrix (pStay diagonal).
 * This uses FILTERED posteriors — never smoothed — so it stays tradeable.
 */
export function dzsHmmState(candles: Candle[], cfg: DzsHmmConfig): DzsHmmState {
  const n = candles.length;
  const closes = candles.map((c) => c.close);

  // observation Xt — log return (stationary) or deviation from moving mean
  let x: number[];
  if (cfg.feature === "deviation") {
    const ma = sma(closes, cfg.zWindow);
    x = closes.map((c, i) => (Number.isFinite(ma[i]) && ma[i] > 0 ? (c - ma[i]) / ma[i] : NaN));
  } else {
    x = logReturns(candles);
  }

  const s = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const sd = rollingStd(x, i, cfg.zWindow);
    if (!Number.isFinite(sd) || !Number.isFinite(x[i])) continue;
    // μ of the same past window
    let sum = 0;
    let cnt = 0;
    for (let j = i - cfg.zWindow; j < i; j++) {
      if (Number.isFinite(x[j])) {
        sum += x[j];
        cnt++;
      }
    }
    if (cnt === 0) continue;
    const mu = sum / cnt;
    s[i] = clamp((x[i] - mu) / (3 * (sd + EPS)), -1, 1);
  }

  // forward filter — states: 0=range, 1=bull, 2=bear
  const centers = [0, cfg.emitCenter, -cfg.emitCenter];
  const jump = (1 - cfg.pStay) / 2;
  const T = [
    [cfg.pStay, jump, jump],
    [jump, cfg.pStay, jump],
    [jump, jump, cfg.pStay],
  ];
  const emit = (st: number, k: number) =>
    Number.isFinite(st) ? Math.exp(-((st - centers[k]) ** 2) / (2 * cfg.emitSigma * cfg.emitSigma)) : 1 / 3;

  const pRange = new Array<number>(n).fill(NaN);
  const pBull = new Array<number>(n).fill(NaN);
  const pBear = new Array<number>(n).fill(NaN);
  let alpha = [1 / 3, 1 / 3, 1 / 3];
  for (let i = 0; i < n; i++) {
    const next = [0, 1, 2].map((j) => {
      const pred = alpha[0] * T[0][j] + alpha[1] * T[1][j] + alpha[2] * T[2][j];
      return pred * emit(s[i], j);
    });
    const norm = next[0] + next[1] + next[2];
    alpha = norm > 0 ? next.map((p) => p / norm) : [1 / 3, 1 / 3, 1 / 3];
    pRange[i] = alpha[0];
    pBull[i] = alpha[1];
    pBear[i] = alpha[2];
  }

  const signal = new Array<Signal>(n).fill("HOLD");
  let bullStreak = 0;
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(s[i])) continue;
    bullStreak = pBull[i] >= cfg.bullProb ? bullStreak + 1 : 0;
    if (pRange[i] >= cfg.rangeProbExit || pBear[i] >= cfg.bearProbExit) {
      signal[i] = "SELL";
      continue;
    }
    const crossed = s[i] >= cfg.sCross && s[i - 1] < cfg.sCross;
    if (crossed && bullStreak >= cfg.persist) signal[i] = "BUY";
  }
  return { s, pRange, pBull, pBear, signal };
}

// ============================================================================
// unified dispatch — used by backtest engine, live tick and charts
// ============================================================================

/** Per-index signal function for the generic backtest engine. */
export function symbolicSignalFn(
  kind: SymbolicKind,
  candles: Candle[],
  configJson: string,
): (i: number) => Signal {
  if (kind === "ATM_SME") {
    const st = atmSmeState(candles, readAtmSmeConfig(configJson));
    return (i) => st.signal[i] ?? "HOLD";
  }
  if (kind === "RMM_BSE") {
    const st = rmmBseState(candles, readRmmBseConfig(configJson));
    return (i) => st.signal[i] ?? "HOLD";
  }
  const st = dzsHmmState(candles, readDzsHmmConfig(configJson));
  return (i) => st.signal[i] ?? "HOLD";
}

/** Latest-candle signal + a normalized score for the live engine's stats. */
export function symbolicLast(
  kind: SymbolicKind,
  candles: Candle[],
  configJson: string,
): { signal: Signal; score: number; label: string } {
  const i = candles.length - 1;
  if (i < 0) return { signal: "HOLD", score: 0, label: "" };
  if (kind === "ATM_SME") {
    const st = atmSmeState(candles, readAtmSmeConfig(configJson));
    const tok = st.tokens[i];
    return { signal: st.signal[i], score: st.v[i] || 0, label: tok ? `توکن ${tok}` : "" };
  }
  if (kind === "RMM_BSE") {
    const st = rmmBseState(candles, readRmmBseConfig(configJson));
    const lbl = rmmLabel(st.m[i]);
    return { signal: st.signal[i], score: st.m[i] || 0, label: lbl ?? "" };
  }
  const st = dzsHmmState(candles, readDzsHmmConfig(configJson));
  const probs = { RANGE: st.pRange[i], BULL: st.pBull[i], BEAR: st.pBear[i] };
  const best = (Object.keys(probs) as (keyof typeof probs)[]).reduce((a, b) =>
    (probs[b] ?? 0) > (probs[a] ?? 0) ? b : a,
  );
  const fa = { RANGE: "رنج", BULL: "صعودی", BEAR: "نزولی" }[best];
  return { signal: st.signal[i], score: (st.pBull[i] || 0) - (st.pBear[i] || 0), label: `رژیم ${fa}` };
}

/** Candles needed for meaningful warm-up in live ticks. */
export function symbolicWarmup(kind: SymbolicKind, configJson: string): number {
  if (kind === "ATM_SME") {
    const c = readAtmSmeConfig(configJson);
    return Math.min(c.probWindow, 1000) + c.volWindow + 20;
  }
  if (kind === "RMM_BSE") {
    const c = readRmmBseConfig(configJson);
    return c.channelLen + c.volPeriod + c.squeezeBars + 20;
  }
  const c = readDzsHmmConfig(configJson);
  return c.zWindow + 40;
}

/** Chart pane series — engine value + level bands (candle-chart OscillatorSeries). */
export function symbolicChartSeries(
  kind: SymbolicKind,
  candles: Candle[],
  configJson: string,
): { name: string; values: number[]; line?: number[]; bands: { v: number; color: string; label: string }[] } {
  if (kind === "ATM_SME") {
    const cfg = readAtmSmeConfig(configJson);
    const st = atmSmeState(candles, cfg);
    return {
      name: "ATM-SME · Vt",
      values: st.v,
      bands: [
        { v: cfg.tokenExtreme, color: "#16a34a", label: "ناحیه A" },
        { v: -cfg.tokenExtreme, color: "#dc2626", label: "ناحیه E" },
        { v: cfg.exitTrigger, color: "#0d9488", label: "ماشه خروج" },
      ],
    };
  }
  if (kind === "RMM_BSE") {
    const cfg = readRmmBseConfig(configJson);
    const st = rmmBseState(candles, cfg);
    return {
      name: "RMM-BSE · Mt",
      values: st.m,
      bands: [
        { v: cfg.breakoutMt, color: "#16a34a", label: "ناحیه ورود" },
        { v: cfg.squeezeAbs, color: "#94a3b8", label: "باند رنج" },
        { v: -cfg.squeezeAbs, color: "#94a3b8", label: "باند رنج" },
        { v: cfg.exitMt, color: "#f59e0b", label: "آستانه خروج" },
      ],
    };
  }
  const cfg = readDzsHmmConfig(configJson);
  const st = dzsHmmState(candles, cfg);
  return {
    name: "DZS-HMM · P(صعودی)",
    values: st.pBull,
    line: st.s.map((x) => (Number.isFinite(x) ? x : NaN)),
    bands: [
      { v: cfg.bullProb, color: "#16a34a", label: "آستانه خرید" },
      { v: cfg.rangeProbExit, color: "#f59e0b", label: "آستانه خروج (رنج)" },
    ],
  };
}
