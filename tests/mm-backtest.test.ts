import { describe, it, expect } from "vitest";
import { runMmBacktest } from "@/modules/backtest/mm-engine";
import { runBacktest } from "@/modules/backtest/engine";
import type { Candle } from "@/modules/exchanges/types";
import type { MmConfig } from "@/modules/trading/market-making";

const cfg = (over: Partial<MmConfig> = {}): MmConfig => ({
  spreadPct: 1,
  orderSizePct: 10,
  levels: 1,
  levelStepPct: 1,
  requotePct: 0.1,
  maxInventoryPct: 60,
  ...over,
});

const mkCandles = (n: number, fn: (i: number) => Pick<Candle, "open" | "high" | "low" | "close">): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: i * 60_000, volume: 1, ...fn(i) }));

// oscillating candles — range sweeps both quote sides every bar
const oscillating = mkCandles(300, (i) => ({
  open: 100, close: 100, low: 98.5 + (i % 2) * 0.4, high: 101.5 - (i % 2) * 0.4,
}));

describe("runMmBacktest", () => {
  const params = {
    cfg: cfg(),
    initialBalance: 10_000,
    feePct: 0.25,
    pricePrecision: 2,
    amountPrecision: 8,
    minAmount: 0,
  };

  it("earns the spread on an oscillating market", () => {
    const r = runMmBacktest({ ...params, candles: oscillating });
    expect(r.totalTrades).toBeGreaterThan(0);
    expect(r.equityCurve).toHaveLength(oscillating.length);
    // spread 1% > round-trip fee 0.5% → cycles profitable
    expect(r.winningTrades).toBe(r.totalTrades);
    expect(r.finalBalance).toBeGreaterThan(r.initialBalance);
    expect(r.trades.every((t) => t.exitReason === "MM_CYCLE" || t.exitReason === "END")).toBe(true);
  });

  it("makes no trades on a flat market", () => {
    const flat = mkCandles(200, () => ({ open: 100, high: 100.2, low: 99.8, close: 100 }));
    const r = runMmBacktest({ ...params, candles: flat });
    expect(r.totalTrades).toBe(0);
    expect(r.finalBalance).toBeCloseTo(r.initialBalance, 6);
  });

  it("marks drawdown on a trending market", () => {
    // strong uptrend — bids keep filling, asks get left behind → inventory marked down then liquidated
    const trend = mkCandles(200, (i) => ({ open: 100 + i * 0.5, high: 101 + i * 0.5, low: 99.8 + i * 0.5, close: 100.5 + i * 0.5 }));
    const r = runMmBacktest({ ...params, candles: trend });
    expect(Number.isFinite(r.maxDrawdown)).toBe(true);
    expect(r.equityCurve.at(-1)!.equity).toBeCloseTo(r.finalBalance, 4);
  });
});

describe("runBacktest signalFn override", () => {
  const candles = mkCandles(150, (i) => ({ open: 100, high: 101, low: 99, close: 100 + i * 0.1 }));

  it("ignores indicators and follows signalFn", () => {
    const r = runBacktest({
      candles,
      indicators: [], // no indicators — only signalFn drives entries
      buyThreshold: 0.5, sellThreshold: -0.5,
      initialBalance: 10_000, riskPerTradePct: 50,
      stopLossPct: 2, takeProfitPct: 5, trailingStop: false,
      feePct: 0.25, slippagePct: 0.05, minCandles: 10,
      signalFn: (i) => (i === 20 ? "BUY" : "HOLD"),
    });
    expect(r.totalTrades).toBe(1);
    expect(r.trades[0].exitReason).toBe("END");
  });

  it("signalFn SELL closes an open position", () => {
    const r = runBacktest({
      candles,
      indicators: [],
      buyThreshold: 0.5, sellThreshold: -0.5,
      initialBalance: 10_000, riskPerTradePct: 50,
      stopLossPct: 50, takeProfitPct: 90, trailingStop: false,
      feePct: 0.25, slippagePct: 0.05, minCandles: 10,
      signalFn: (i) => (i === 20 ? "BUY" : i === 40 ? "SELL" : "HOLD"),
    });
    expect(r.trades[0].exitReason).toBe("SIGNAL");
    expect(r.trades[0].exitTime).toBe(candles[40].time);
  });
});
