import { describe, it, expect } from "vitest";
import { featureVectorAt, precompute, FEATURE_NAMES } from "@/modules/forecast/features";
import { tripleBarrierLabel, HORIZON_CONFIGS, type DatasetRow } from "@/modules/forecast/dataset";
import { trainLogReg, predictProba, serializeModel, deserializeModel } from "@/modules/forecast/model";
import { evaluate, passesHonestyGate, aucScore, brierScore } from "@/modules/forecast/validate";
import type { Candle } from "@/modules/exchanges/types";

function candles(closes: number[], vol = 100): Candle[] {
  return closes.map((c, i) => ({
    time: i * 900_000, open: c * 0.999, high: c * 1.004, low: c * 0.996, close: c, volume: vol + (i % 9) * 7,
  }));
}

describe("features — causality and shape", () => {
  const c = candles(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 10) * 5 + i * 0.05));
  const pre = precompute(c);

  it("returns null before warmup and a full vector after", () => {
    expect(featureVectorAt(c, pre, 10)).toBeNull();
    const f = featureVectorAt(c, pre, 150);
    expect(f).not.toBeNull();
    expect(f!.length).toBe(FEATURE_NAMES.length);
    for (const v of f!) expect(Number.isFinite(v)).toBe(true);
  });

  it("is causal — changing the future does not change the past", () => {
    const a = featureVectorAt(c, pre, 150)!;
    const shocked = [...c.slice(0, 151), ...candles(Array.from({ length: 49 }, () => 9999))];
    const b = featureVectorAt(shocked, precompute(shocked), 150)!;
    expect(b).toEqual(a);
  });

  it("horizons cover 5m/15m/1h/4h/12h", () => {
    expect(HORIZON_CONFIGS.map((h) => h.horizon)).toEqual(["5m", "15m", "1h", "4h", "12h"]);
  });
});

describe("tripleBarrierLabel", () => {
  const atrOf = (n: number, v = 1) => new Array(n).fill(v);

  it("labels up-hit 1, down-hit 0, neither null", () => {
    const up = candles([100, 100, 100, 100, 106]);
    expect(tripleBarrierLabel(up, atrOf(5), 0, 4, 1.5)).toBe(1);
    const dn = candles([100, 100, 100, 100, 94]);
    expect(tripleBarrierLabel(dn, atrOf(5), 0, 4, 1.5)).toBe(0);
    const flat = candles([100, 100, 100, 100, 100.1]);
    expect(tripleBarrierLabel(flat, atrOf(5), 0, 4, 1.5)).toBeNull();
  });

  it("returns null when ATR is unusable", () => {
    const c = candles([100, 106]);
    expect(tripleBarrierLabel(c, atrOf(2, 0), 0, 1, 1.5)).toBeNull();
  });
});

/** separable synthetic dataset: feature[0] sign decides the label */
function separable(n: number): { X: number[][]; y: (0 | 1)[] } {
  const X: number[][] = [], y: (0 | 1)[] = [];
  let s = 12345;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const pos = i % 2 === 0;
    const row = Array.from({ length: FEATURE_NAMES.length }, (_, j) =>
      j === 0 ? (pos ? 1 : -1) + (rnd() - 0.5) * 0.4 : rnd() - 0.5);
    X.push(row);
    y.push(pos ? 1 : 0);
  }
  return { X, y };
}

const rowsOf = (X: number[][], y: (0 | 1)[]): DatasetRow[] =>
  X.map((features, i) => ({ time: i, features, label: y[i] }));

describe("trainLogReg + evaluate + honesty gate", () => {
  const { X, y } = separable(800);
  const model = trainLogReg(X.slice(0, 560), y.slice(0, 560));
  const testRows = rowsOf(X.slice(560), y.slice(560));

  it("fits separable data — high AUC out-of-sample", () => {
    const m = evaluate(model, testRows);
    expect(m.auc).toBeGreaterThan(0.85);
    expect(m.brier).toBeLessThan(m.brierBaseline);
    expect(m.calibration.length).toBeGreaterThan(0);
    expect(m.winRateByConfidence.length).toBe(5);
  });

  it("passesHonestyGate accepts a real edge", () => {
    const m = evaluate(model, testRows);
    const gate = passesHonestyGate(m);
    expect(gate.pass).toBe(true);
  });

  it("passesHonestyGate rejects noise", () => {
    const noise = trainLogReg(
      X.slice(0, 560).map((r) => r.map(() => Math.random() - 0.5)),
      y.slice(0, 560));
    const m = evaluate(noise, testRows);
    const gate = passesHonestyGate(m);
    expect(gate.pass).toBe(false);
    expect(gate.reasons.length).toBeGreaterThan(0);
  });

  it("serialize/deserialize roundtrips predictions", () => {
    const m2 = deserializeModel(serializeModel(model), [...FEATURE_NAMES]);
    for (const x of X.slice(0, 10)) {
      expect(predictProba(m2, x)).toBeCloseTo(predictProba(model, x), 10);
    }
  });
});

describe("metric primitives", () => {
  it("perfect predictions → auc 1, brier 0", () => {
    const labels = [1, 0, 1, 0, 1] as (0 | 1)[];
    expect(aucScore([1, 0, 1, 0, 1], labels)).toBe(1);
    expect(brierScore([1, 0, 1, 0, 1], labels)).toBe(0);
  });

  it("coin-flip probabilities → auc ~0.5", () => {
    const labels = [1, 0, 1, 0] as (0 | 1)[];
    expect(aucScore([0.5, 0.5, 0.5, 0.5], labels)).toBe(0.5);
  });
});
