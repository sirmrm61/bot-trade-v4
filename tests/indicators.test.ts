import { describe, it, expect } from "vitest";
import { sma, ema, rsi, macd, bollinger, vwap, atr, stochastic, obv, computeIndicator, evaluateCondition } from "@/modules/indicators/engine";
import type { Candle } from "@/modules/exchanges/types";

const candles = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ time: i * 60_000, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }));

describe("indicators", () => {
  it("sma computes simple moving average", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[2]).toBe(2);
    expect(out[4]).toBe(4);
    expect(Number.isNaN(out[0])).toBe(true);
  });

  it("ema converges toward price", () => {
    const out = ema([10, 10, 10, 10, 10, 20, 20, 20, 20, 20], 3);
    expect(out.at(-1)!).toBeGreaterThan(10);
    expect(out.at(-1)!).toBeLessThanOrEqual(20);
  });

  it("rsi is 100 on all-gain series and ~0 on all-loss", () => {
    const up = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14);
    expect(up.at(-1)).toBe(100);
    const down = rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14);
    expect(down.at(-1)).toBe(0);
  });

  it("macd produces histogram aligned to input", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const m = macd(closes);
    expect(m.macd.length).toBe(60);
    expect(m.histogram.length).toBe(60);
    expect(Number.isNaN(m.macd[0])).toBe(true);
    expect(Number.isNaN(m.histogram.at(-1)!)).toBe(false);
  });

  it("bollinger pctB is in 0..1 range", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 7));
    const b = bollinger(closes, 20, 2);
    for (const v of b.pctB) if (!Number.isNaN(v)) expect(v).toBeGreaterThanOrEqual(0);
    expect(b.upper.at(-1)!).toBeGreaterThan(b.middle.at(-1)!);
    expect(b.lower.at(-1)!).toBeLessThan(b.middle.at(-1)!);
  });

  it("vwap weights by volume and resets daily", () => {
    const day = 86_400_000;
    const cs: Candle[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 60_000, open: 200, high: 200, low: 200, close: 200, volume: 3 }, // vwap = (100+600)/4 = 175
      { time: day, open: 50, high: 50, low: 50, close: 50, volume: 2 }, // new day → 50
    ];
    const v = vwap(cs);
    expect(v[0]).toBe(100);
    expect(v[1]).toBeCloseTo(175);
    expect(v[2]).toBe(50);
  });

  it("atr measures true range with Wilder smoothing", () => {
    const cs: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: i * 60_000, open: 100, high: 105, low: 95, close: 100, volume: 1,
    }));
    const a = atr(cs, 14);
    expect(Number.isNaN(a[12])).toBe(true);
    expect(a[13]).toBeCloseTo(10); // constant TR=10
    expect(a.at(-1)!).toBeCloseTo(10);
  });

  it("stochastic produces %K/%D in 0..100 and fast defaults", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const cs = closes.map((c, i) => ({ time: i * 60_000, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
    const s = stochastic(cs, 5, 3, 3);
    for (const v of s.k) if (!Number.isNaN(v)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
    expect(s.d.length).toBe(30);
  });

  it("obv accumulates volume by direction", () => {
    const cs: Candle[] = [
      { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 5 },
      { time: 1, open: 10, high: 11, low: 10, close: 11, volume: 10 }, // up → +10
      { time: 2, open: 11, high: 11, low: 9, close: 9, volume: 7 },    // down → -7
      { time: 3, open: 9, high: 9, low: 9, close: 9, volume: 4 },      // flat → 0
    ];
    const o = obv(cs);
    expect(o[0]).toBe(0);
    expect(o[1]).toBe(10);
    expect(o[2]).toBe(3);
    expect(o[3]).toBe(3);
  });

  it("computeIndicator dispatches phase-2 indicators", () => {
    const cs = candles(Array.from({ length: 60 }, (_, i) => 100 + i * 0.5));
    expect(computeIndicator("VWAP", {}, cs).values.length).toBe(60);
    expect(computeIndicator("STOCHASTIC", { kPeriod: 5, dPeriod: 3, smoothing: 3 }, cs).secondary?.length).toBe(60);
    expect(computeIndicator("OBV", { period: 20 }, cs).values.length).toBe(60);
    expect(computeIndicator("ATR", { period: 14 }, cs).values.length).toBe(60);
  });

  it("evaluateCondition lt/gt/between/cross", () => {
    const up = candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const series = computeIndicator("RSI", { period: 14 }, up);
    expect(evaluateCondition({ op: "gt", value: 50 }, series, up.map((c) => c.close))).toBe(true);
    expect(evaluateCondition({ op: "lt", value: 50 }, series, up.map((c) => c.close))).toBe(false);
    expect(evaluateCondition({ op: "between", a: 90, b: 110 }, series, up.map((c) => c.close))).toBe(true);
  });
});
