import { clamp, parseJson } from "@/shared/utils";
import { symbolicSeries, type SymbolicKind, type SymbolicDetail } from "./symbolic-engines";

/**
 * Smart layer — the symbolic engines learn from their own closed trades.
 *
 * Four mechanisms, all driven by realized pnlPct of each closed trade and
 * persisted in LiveStrategy.stats.learn (JSON):
 *
 * 1) Adaptive thresholds — a strictness scalar tightens entry/exit params
 *    after losses and relaxes them (toward base) after wins.
 * 2) Context memory — per-context stats (token pattern / channel label /
 *    regime) veto entries that historically lose.
 * 3) Learned sizing — riskPerTradePct scales by the win-rate of the
 *    signal-quality bucket the signal fell into.
 * 4) Online scorer — a perceptron over engine features gates entries
 *    when enough history exists.
 *
 * State never leaves the safe bounds — adaptConfig writes into the config
 * JSON and the engine's clamped readers re-validate it.
 */

export interface CtxStats { w: number; l: number; pnl: number }

export interface SmartLearn {
  n: number;                          // closed trades learned from
  strict: number;                     // -1 loose .. +1 strict
  contexts: Record<string, CtxStats>; // `${kind}:${context}` → stats
  buckets: Record<string, CtxStats>;  // "hi" | "lo" signal quality → stats
  w: number[];                        // online scorer weights
}

/** What the engine reports about the candle that produced its signal. */
export type SmartDetail = SymbolicDetail;

export function smartEnabled(configJson: string): boolean {
  return parseJson<{ smart?: boolean }>(configJson, {}).smart === true;
}

export function readLearn(statsJson: string): SmartLearn {
  const raw = parseJson<{ learn?: Partial<SmartLearn> }>(statsJson, {}).learn;
  return {
    n: Math.max(0, Math.floor(raw?.n ?? 0)),
    strict: clamp(raw?.strict ?? 0, -1, 1),
    contexts: raw?.contexts ?? {},
    buckets: raw?.buckets ?? {},
    w: Array.isArray(raw?.w) ? raw!.w.map(Number) : [],
  };
}

// --- adaptive thresholds -----------------------------------------------------
// direction: +1 → stricter means larger value; -1 → stricter means smaller.
// The band is a tight *sensible* adaptation range, NOT the validation range —
// adapting within e.g. gamma's full [0.01,100] would explode the token map.
const STRICT_PARAMS: Record<SymbolicKind, [string, number, number, number][]> = {
  //              [param,            dir, bandLo, bandHi]
  ATM_SME: [
    ["recoverVt",        +1, -0.6, 0],
    ["minPatternWinRate",+1, 0.3, 0.8],
    ["gamma",            +1, 0.5, 4],
    ["exitTrigger",      -1, 0.3, 0.9],
    ["exitBack",         +1, 0.1, 0.6],
    ["weakenVt",         -1, 0, 0.6],
  ],
  RMM_BSE: [
    ["breakoutMt", +1, 0.5, 0.95],
    ["volMult",    +1, 1.0, 3],
    ["squeezeBars",+1, 2, 12],
    ["exitMt",     +1, 0, 0.5],
  ],
  DZS_HMM: [
    ["bullProb",      +1, 0.55, 0.95],
    ["sCross",        +1, 0.1, 0.7],
    ["persist",       +1, 1, 6],
    ["rangeProbExit", -1, 0.3, 0.8],
    ["bearProbExit",  -1, 0.3, 0.8],
  ],
};

const KIND_KEY: Record<SymbolicKind, "atmSme" | "rmmBse" | "dzsHmm"> = {
  ATM_SME: "atmSme", RMM_BSE: "rmmBse", DZS_HMM: "dzsHmm",
};

const INT_PARAMS = new Set(["squeezeBars", "persist"]);

/** Apply learned strictness to the engine's tunable params — returns new configJson. */
export function adaptConfig(kind: SymbolicKind, configJson: string, learn: SmartLearn): string {
  if (learn.strict === 0) return configJson;
  const root = parseJson<Record<string, unknown>>(configJson, {});
  const key = KIND_KEY[kind];
  const inner = { ...((root[key] as Record<string, unknown>) ?? {}) };
  for (const [param, dir, lo, hi] of STRICT_PARAMS[kind]) {
    const base = inner[param];
    if (typeof base !== "number") continue;
    // a base outside the band is a deliberate choice (e.g. minPatternWinRate=0
    // disables the pattern gate) — don't adapt it at all
    if (base < lo || base > hi) continue;
    const mag = (hi - lo) * 0.25 * learn.strict; // up to ±25% of the band
    let v = clamp(base + dir * mag, lo, hi);
    if (INT_PARAMS.has(param)) v = Math.round(v);
    inner[param] = v;
  }
  return JSON.stringify({ ...root, [key]: inner });
}

// --- context veto + learned sizing + online scorer ---------------------------

const MIN_SAMPLES = 4;
const VETO_WINRATE = 0.4;
const GATE_SCORE = 0.4;
const GATE_AFTER = 5;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function decideEntry(kind: SymbolicKind, learn: SmartLearn, d: SmartDetail): {
  allow: boolean;
  sizeMult: number;
  smartScore: number;
  veto?: string;
} {
  const pred = learn.w.length === d.x.length ? sigmoid(learn.w.reduce((a, w, i) => a + w * d.x[i], 0)) : 0.5;

  // idea 2 — context veto: this pattern/label/regime historically loses
  const cs = learn.contexts[`${kind}:${d.context}`];
  if (cs && cs.w + cs.l >= MIN_SAMPLES && cs.w / (cs.w + cs.l) < VETO_WINRATE) {
    return { allow: false, sizeMult: 1, smartScore: pred, veto: `ctx:${d.context}` };
  }

  // idea 4 — scorer gate once warmed up
  if (learn.n >= GATE_AFTER && pred < GATE_SCORE) {
    return { allow: false, sizeMult: 1, smartScore: pred, veto: "score" };
  }

  // idea 3 — learned sizing: scale risk by the bucket's realized edge
  const bs = learn.buckets[d.bucket];
  let sizeMult = 1;
  if (bs && bs.w + bs.l >= 3) {
    const edge = bs.w / (bs.w + bs.l) - 0.5;
    sizeMult = clamp(1 + edge * 1.5, 0.5, 1.75);
  }
  return { allow: true, sizeMult, smartScore: pred };
}

/** Fold a closed trade's outcome into the learn state. Pure — returns a new object. */
export function recordOutcome(
  kind: SymbolicKind,
  learn: SmartLearn,
  d: SmartDetail,
  pnlPct: number,
): SmartLearn {
  const next: SmartLearn = {
    n: learn.n + 1,
    strict: clamp(learn.strict + (pnlPct <= 0 ? 0.12 : -0.04), -1, 1),
    contexts: { ...learn.contexts },
    buckets: { ...learn.buckets },
    w: learn.w.length === d.x.length ? [...learn.w] : new Array(d.x.length).fill(0),
  };

  const win = pnlPct > 0;
  const bump = (rec: Record<string, CtxStats>, k: string) => {
    const s = rec[k] ?? { w: 0, l: 0, pnl: 0 };
    rec[k] = { w: s.w + (win ? 1 : 0), l: s.l + (win ? 0 : 1), pnl: s.pnl + pnlPct };
  };
  bump(next.contexts, `${kind}:${d.context}`);
  bump(next.buckets, d.bucket);

  // perceptron-style update — scale the step by how wrong we were
  const pred = sigmoid(next.w.reduce((a, w, i) => a + w * d.x[i], 0));
  const err = (win ? 1 : 0) - pred;
  const lr = 0.08;
  for (let i = 0; i < next.w.length; i++) next.w[i] = clamp(next.w[i] + lr * err * d.x[i], -10, 10);

  return next;
}

// --- backtest integration ----------------------------------------------------

export interface SmartSignalFn {
  (i: number, holding?: boolean): "BUY" | "SELL" | "HOLD";
  onTradeClosed: (pnlPct: number, entryIdx: number, exitIdx: number) => void;
  /** final learn state — tests/UI can inspect what the run learned */
  getLearn: () => SmartLearn;
}

/**
 * Stateful signal function for the backtest engine — learns in-simulation.
 * The engine calls onTradeClosed after every closed position; the entry's
 * detail (last non-HOLD eval) is folded into the learn state, and the
 * signal series is recomputed under the adapted config. Recompute happens
 * only when learn.n changes, so it stays O(trades × candles).
 */
export function smartSignalFn(
  kind: SymbolicKind,
  candles: Parameters<typeof symbolicSeries>[1],
  configJson: string,
  seed?: SmartLearn,
): SmartSignalFn {
  let learn: SmartLearn = seed ?? { n: 0, strict: 0, contexts: {}, buckets: {}, w: [] };
  let series = symbolicSeries(kind, candles, configJson);
  let cachedN = -1;
  // allowed entry-candidate signals with their index — only recorded while
  // flat (the engine flags holding=evals); a close resolves to the newest
  // signal at-or-before the fill candle (execution delay included)
  const pending: { i: number; d: SmartDetail }[] = [];

  const fn = ((i: number, holding = false) => {
    if (cachedN !== learn.n) {
      series = symbolicSeries(kind, candles, adaptConfig(kind, configJson, learn));
      cachedN = learn.n;
    }
    const sig = series.signal[i] ?? "HOLD";
    if (sig === "HOLD" || holding) return sig; // exit-checks never become entries
    const d = series.detailAt(i);
    if (!d) return sig;
    if (!decideEntry(kind, learn, d).allow) return "HOLD";
    pending.push({ i, d });
    if (pending.length > 16) pending.shift();
    return sig;
  }) as SmartSignalFn;

  fn.onTradeClosed = (pnlPct, entryIdx) => {
    // pending contains only flat-state signals — find the newest one
    // at-or-before the fill, then drop it + all older stale ones
    let hitIdx = -1;
    for (let k = pending.length - 1; k >= 0; k--) {
      if (pending[k].i <= entryIdx) { hitIdx = k; break; }
    }
    if (hitIdx < 0) return; // no recorded entry context — skip rather than learn noise
    learn = recordOutcome(kind, learn, pending[hitIdx].d, pnlPct);
    pending.splice(0, hitIdx + 1);
  };
  fn.getLearn = () => learn;
  return fn;
}
