import { describe, it, expect } from "vitest";
import { computeSignal } from "@/modules/signals/engine";
import type { Candle } from "@/modules/exchanges/types";

const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: i * 60_000, open: c, high: c, low: c, close: c, volume: 1 }));

describe("weighted signal engine", () => {
  const strongUp = candles(Array.from({ length: 100 }, (_, i) => 100 + i));

  it("returns BUY when score >= buyThreshold", () => {
    const r = computeSignal(
      [{ name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true, buyCondition: JSON.stringify({ op: "gt", value: 50 }) }],
      strongUp, 0.5, -0.5,
    );
    expect(r.signal).toBe("BUY");
    expect(r.score).toBeGreaterThan(0);
  });

  it("returns SELL on sellCondition", () => {
    const r = computeSignal(
      [{ name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true, sellCondition: JSON.stringify({ op: "gt", value: 50 }) }],
      strongUp, 0.5, -0.5,
    );
    expect(r.signal).toBe("SELL");
  });

  it("HOLD when no indicator enabled", () => {
    const r = computeSignal(
      [{ name: "RSI", parameters: { period: 14 }, weight: 0, enabled: false }],
      strongUp, 0.5, -0.5,
    );
    expect(r.signal).toBe("HOLD");
    expect(r.score).toBe(0);
  });

  it("ATR never contributes to the signal score", () => {
    const r = computeSignal(
      [
        { name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true, buyCondition: JSON.stringify({ op: "gt", value: 50 }) },
        { name: "ATR", parameters: { period: 14 }, weight: 9, enabled: true }, // heavy weight — must be ignored
      ],
      strongUp, 0.5, -0.5,
    );
    expect(r.signal).toBe("BUY"); // RSI alone decides
    expect(r.breakdown.some((b) => b.name === "ATR")).toBe(false);
  });

  it("new scoring indicators (VWAP/STOCHASTIC/OBV) participate", () => {
    // monotonic rise: VWAP bullish, STOCHASTIC overbought (bearish), OBV bullish
    const r = computeSignal(
      [
        { name: "VWAP", parameters: {}, weight: 0.5, enabled: true },
        { name: "STOCHASTIC", parameters: { kPeriod: 5, dPeriod: 3, smoothing: 3 }, weight: 0.5, enabled: true },
        { name: "OBV", parameters: { period: 20 }, weight: 0.5, enabled: true },
      ],
      strongUp, 0.6, -0.6,
    );
    expect(r.breakdown.length).toBe(3);
    expect(r.score).toBeGreaterThanOrEqual(-1);
    expect(r.score).toBeLessThanOrEqual(1);
    const stoch = r.breakdown.find((b) => b.name === "STOCHASTIC");
    const vw = r.breakdown.find((b) => b.name === "VWAP");
    expect(stoch!.score).toBeLessThan(0);   // %K=100 on steady rise → overbought
    expect(vw!.score).toBeGreaterThan(0);   // price above VWAP → bullish
  });

  it("weight normalization keeps score in [-1,1]", () => {
    const r = computeSignal(
      [
        { name: "RSI", parameters: { period: 14 }, weight: 3, enabled: true },
        { name: "EMA", parameters: { period: 20 }, weight: 7, enabled: true },
      ],
      strongUp, 2, -2,
    );
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(-1);
  });
});
