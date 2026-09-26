import { describe, it, expect } from "vitest";
import {
  atmSmeSeries,
  atmToken,
  atmSmeState,
  rmmBseSeries,
  rmmLabel,
  rmmBseState,
  dzsHmmState,
  readAtmSmeConfig,
  readRmmBseConfig,
  readDzsHmmConfig,
  symbolicSignalFn,
  symbolicLast,
  symbolicWarmup,
  isSymbolicKind,
} from "@/modules/trading/symbolic-engines";
import type { Candle } from "@/modules/exchanges/types";

function mkCandles(closes: number[], opts: { spread?: number; volume?: number } = {}): Candle[] {
  const spread = opts.spread ?? 0.01;
  return closes.map((c, i) => ({
    time: i * 60_000,
    open: c * 0.999,
    high: c * (1 + spread),
    low: c * (1 - spread),
    close: c,
    volume: opts.volume ?? 100,
  }));
}

const atmCfg = readAtmSmeConfig(JSON.stringify({}));
const rmmCfg = readRmmBseConfig(JSON.stringify({}));
const dzsCfg = readDzsHmmConfig(JSON.stringify({}));

describe("ATM-SME", () => {
  it("normalizes returns into [-1,1] via tanh", () => {
    const candles = mkCandles(Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.002 * i)));
    const v = atmSmeSeries(candles, atmCfg);
    for (const x of v.slice(30)) {
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it("maps V to A-E tokens at the configured edges", () => {
    const cfg = { ...atmCfg, tokenMid: 0.2, tokenExtreme: 0.6 };
    expect(atmToken(0.7, cfg)).toBe("A");
    expect(atmToken(0.4, cfg)).toBe("B");
    expect(atmToken(0, cfg)).toBe("C");
    expect(atmToken(-0.4, cfg)).toBe("D");
    expect(atmToken(-0.7, cfg)).toBe("E");
    expect(atmToken(NaN, cfg)).toBeNull();
  });

  it("fires BUY on an E,E,C exhaustion pattern with recovery + history gate disabled", () => {
    // noisy history so σ>0, then sharp dumps → E tokens, then a small
    // positive candle → C token with V above the recover level
    const closes = [
      ...Array.from({ length: 25 }, (_, i) => 100 + 1.0 * Math.sin(i * 1.3)),
      97, 94, 91, // −3% dumps → E tokens
      91.25, // small recovery → C token
    ];
    const candles = mkCandles(closes);
    const cfg = { ...atmCfg, minPatternWinRate: 0, useEmaConfirm: false };
    const st = atmSmeState(candles, cfg);
    expect(st.tokens.at(-1)).toBe("C");
    expect(st.signal.at(-1)).toBe("BUY");
  });

  it("emits SELL on momentum decay (peak above trigger, fall back)", () => {
    // pump hard then fade — V spikes above 0.7 then collapses
    const closes = [
      ...Array.from({ length: 25 }, () => 100),
      104, 108, 113, // pump → A zone
      112, 110, 107, 104, 101, // fade back down
    ];
    const candles = mkCandles(closes);
    const st = atmSmeState(candles, { ...atmCfg, minPatternWinRate: 0, useEmaConfirm: false });
    expect(st.signal.some((s) => s === "SELL")).toBe(true);
  });
});

describe("RMM-BSE", () => {
  it("maps close position inside the prior channel to [-1,1]", () => {
    const closes = Array.from({ length: 40 }, () => 100);
    const candles = mkCandles(closes);
    const m = rmmBseSeries(candles, rmmCfg);
    // flat market → close sits mid-channel
    expect(m[39]).toBeCloseTo(0, 1);
  });

  it("labels the breakout zones", () => {
    expect(rmmLabel(0.95)).toBe("UP_BREAK");
    expect(rmmLabel(0.5)).toBe("MID_BULL");
    expect(rmmLabel(0)).toBe("SQUEEZE");
    expect(rmmLabel(-0.5)).toBe("MID_BEAR");
    expect(rmmLabel(-0.95)).toBe("DN_BREAK");
  });

  it("fires BUY on a volume-confirmed breakout after a squeeze", () => {
    const closes = [
      ...Array.from({ length: 30 }, (_, i) => 100 + 0.02 * Math.sin(i)), // tight range
      103, // breakout close above the channel
    ];
    const candles = mkCandles(closes);
    candles[candles.length - 1].volume = 500; // ≥ 1.5× avg
    const st = rmmBseState(candles, rmmCfg);
    expect(st.signal[candles.length - 1]).toBe("BUY");
  });

  it("blocks the entry when volume confirmation is missing", () => {
    const closes = [
      ...Array.from({ length: 30 }, (_, i) => 100 + 0.02 * Math.sin(i)),
      103,
    ];
    const candles = mkCandles(closes); // volume = avg, below the 1.5× gate
    const st = rmmBseState(candles, rmmCfg);
    expect(st.signal[candles.length - 1]).not.toBe("BUY");
    // but disabling the gate lets the structural break through
    const st2 = rmmBseState(candles, { ...rmmCfg, useVolumeConfirm: false });
    expect(st2.signal[candles.length - 1]).toBe("BUY");
  });

  it("emits SELL when M falls back below the exit level", () => {
    const closes = [
      ...Array.from({ length: 25 }, () => 100),
      95, // drop → M near channel floor
    ];
    const candles = mkCandles(closes);
    const st = rmmBseState(candles, rmmCfg);
    expect(st.signal[candles.length - 1]).toBe("SELL");
  });
});

describe("DZS-HMM", () => {
  it("keeps St bounded in [-1,1] and probabilities summing to ~1", () => {
    const candles = mkCandles(Array.from({ length: 150 }, (_, i) => 100 * (1 + 0.001 * i)));
    const st = dzsHmmState(candles, dzsCfg);
    for (let i = 80; i < 150; i++) {
      expect(st.s[i]).toBeGreaterThanOrEqual(-1);
      expect(st.s[i]).toBeLessThanOrEqual(1);
      expect(st.pRange[i] + st.pBull[i] + st.pBear[i]).toBeCloseTo(1, 5);
    }
  });

  it("raises P(bull) when returns accelerate above the rolling mean", () => {
    // flat noisy regime, then a strong consistent uptrend → positive z → bull state
    const closes = Array.from({ length: 150 }, (_, i) =>
      i < 80 ? 100 + 0.5 * Math.sin(i) : 100 * Math.pow(1.012, i - 79));
    const candles = mkCandles(closes);
    const st = dzsHmmState(candles, dzsCfg);
    expect(Math.max(...st.pBull.slice(80))).toBeGreaterThanOrEqual(0.7);
    expect(Math.max(...st.pBull.slice(80))).toBeGreaterThan(st.pBull[60]);
  });

  it("emits SELL when the range/bear states dominate", () => {
    // choppy flat market — range state should dominate
    const candles = mkCandles(Array.from({ length: 150 }, (_, i) => 100 + 0.1 * Math.sin(i / 2)));
    const st = dzsHmmState(candles, { ...dzsCfg, rangeProbExit: 0.4 });
    expect(st.signal.some((s) => s === "SELL")).toBe(true);
  });
});

describe("dispatch", () => {
  it("isSymbolicKind recognises only the three engines", () => {
    expect(isSymbolicKind("ATM_SME")).toBe(true);
    expect(isSymbolicKind("RMM_BSE")).toBe(true);
    expect(isSymbolicKind("DZS_HMM")).toBe(true);
    expect(isSymbolicKind("SIGNAL")).toBe(false);
    expect(isSymbolicKind("MARKET_MAKING")).toBe(false);
  });

  it("symbolicSignalFn evaluates per index and symbolicLast reports the last candle", () => {
    const candles = mkCandles(Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.001 * i)));
    const fn = symbolicSignalFn("DZS_HMM", candles, "{}");
    expect(["BUY", "SELL", "HOLD"]).toContain(fn(79));
    const last = symbolicLast("RMM_BSE", candles, "{}");
    expect(["BUY", "SELL", "HOLD"]).toContain(last.signal);
    expect(Number.isFinite(last.score)).toBe(true);
  });

  it("symbolicWarmup scales with the configured windows", () => {
    const small = symbolicWarmup("RMM_BSE", "{}");
    const big = symbolicWarmup("RMM_BSE", JSON.stringify({ rmmBse: { channelLen: 100 } }));
    expect(big).toBeGreaterThan(small);
  });
});
