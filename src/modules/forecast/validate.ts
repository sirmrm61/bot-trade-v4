import type { LogRegModel } from "./model";
import { predictProba } from "./model";
import type { DatasetRow } from "./dataset";

/**
 * Honest evaluation — everything is measured on the out-of-sample tail of a
 * time-ordered split. If the model doesn't beat the trivial baseline there,
 * the metrics say so plainly and the caller must NOT use it in decisions.
 */

export interface CalibrationBin {
  lo: number; hi: number;
  meanPred: number;
  actualRate: number;
  n: number;
}

export interface EvalMetrics {
  n: number;
  auc: number;            // 0.5 = random
  brier: number;          // lower is better
  brierBaseline: number;  // constant base-rate predictor — the bar to beat
  logLoss: number;
  baseRate: number;
  calibration: CalibrationBin[];   // 10 bins
  winRateByConfidence: { minConf: number; n: number; winRate: number; avgP: number }[];
}

export function aucScore(probs: number[], labels: (0 | 1)[]): number {
  // rank-based AUC — O(n log n); ties get mid-ranks so constant probs → 0.5
  const idx = probs.map((p, i) => i).sort((a, b) => probs[a] - probs[b]);
  const n1 = labels.filter((l) => l === 1).length;
  const n0 = labels.length - n1;
  if (!n1 || !n0) return 0.5;
  const ranks = new Array<number>(idx.length);
  for (let r = 0; r < idx.length; r++) {
    let e = r;
    while (e + 1 < idx.length && probs[idx[e + 1]] === probs[idx[r]]) e++;
    const mid = (r + e) / 2 + 1;
    for (let t = r; t <= e; t++) ranks[idx[t]] = mid;
    r = e;
  }
  let rankSum = 0;
  for (let i = 0; i < idx.length; i++) if (labels[i] === 1) rankSum += ranks[i];
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

export function brierScore(probs: number[], labels: (0 | 1)[]): number {
  if (!probs.length) return 1;
  let s = 0;
  for (let i = 0; i < probs.length; i++) s += (probs[i] - labels[i]) ** 2;
  return s / probs.length;
}

export function evaluate(model: LogRegModel, rows: DatasetRow[]): EvalMetrics {
  const probs = rows.map((r) => predictProba(model, r.features));
  const labels = rows.map((r) => r.label);
  const n = rows.length;
  const baseRate = n ? labels.filter((l) => l === 1).length / n : 0.5;

  const probsClamped = probs.map((p) => Math.min(Math.max(p, 1e-7), 1 - 1e-7));
  const logLoss = n
    ? -labels.reduce<number>((s, l, i) => s + l * Math.log(probsClamped[i]) + (1 - l) * Math.log(1 - probsClamped[i]), 0) / n
    : 1;

  // calibration — 10 equal-width bins
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10, hi = (b + 1) / 10;
    const idxs = probs.map((p, i) => (p >= lo && (p < hi || (b === 9 && p <= 1))) ? i : -1).filter((i) => i >= 0);
    if (!idxs.length) continue;
    bins.push({
      lo, hi,
      meanPred: idxs.reduce((s, i) => s + probs[i], 0) / idxs.length,
      actualRate: idxs.reduce((s, i) => s + labels[i], 0) / idxs.length,
      n: idxs.length,
    });
  }

  // win rate at growing confidence thresholds — the operationally useful view
  const winRateByConfidence = [0, 0.1, 0.16, 0.24, 0.32].map((minConf) => {
    const sel = probs.map((p, i) => ({ p, l: labels[i] })).filter(({ p }) => Math.abs(p - 0.5) * 2 >= minConf);
    return {
      minConf,
      n: sel.length,
      winRate: sel.length ? sel.filter(({ p, l }) => (p >= 0.5 ? l === 1 : l === 0)).length / sel.length : 0,
      avgP: sel.length ? sel.reduce((s, { p }) => s + p, 0) / sel.length : 0.5,
    };
  });

  return {
    n,
    auc: aucScore(probs, labels),
    brier: brierScore(probs, labels),
    brierBaseline: brierScore(labels.map(() => baseRate), labels),
    logLoss,
    baseRate,
    calibration: bins,
    winRateByConfidence,
  };
}

/** does the model beat the trivial baseline on the test segment? */
export function passesHonestyGate(test: EvalMetrics): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (test.n < 200) reasons.push(`نمونه‌ی تست کم است (${test.n} < 200)`);
  // AUC margin — below ~0.52 it's within noise of a coin flip
  if (!(test.auc > 0.52)) reasons.push(`AUC آزمون ${test.auc.toFixed(3)} ≤ 0.52 — بهتر از تصادفی نیست`);
  if (!(test.brier < test.brierBaseline)) reasons.push(`Brier ${test.brier.toFixed(4)} بدتر از baseline ${test.brierBaseline.toFixed(4)}`);
  return { pass: reasons.length === 0, reasons };
}
