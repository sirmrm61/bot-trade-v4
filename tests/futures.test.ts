import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestParams } from "@/modules/backtest/engine";
import { readMarketConfig, liquidationPrice, futuresPnl } from "@/modules/trading/futures";
import type { Candle } from "@/modules/exchanges/types";

function candles(prices: number[], step = 60_000): Candle[] {
  return prices.map((p, i) => ({ time: i * step, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: 10 }));
}

const base: Omit<BacktestParams, "candles" | "signalFn"> = {
  indicators: [],
  buyThreshold: 0.35,
  sellThreshold: -0.35,
  initialBalance: 10_000,
  riskPerTradePct: 50,
  stopLossPct: 5,
  takeProfitPct: 10,
  trailingStop: false,
  feePct: 0,
  slippagePct: 0,
  minCandles: 2,
};

/** signal sequence: index → BUY/SELL/HOLD */
const seq = (map: Record<number, "BUY" | "SELL">) => (i: number) => map[i] ?? "HOLD";

describe("readMarketConfig", () => {
  it("defaults to SPOT leverage 1", () => {
    expect(readMarketConfig("{}")).toEqual({ market: "SPOT", leverage: 1 });
    expect(readMarketConfig("not json")).toEqual({ market: "SPOT", leverage: 1 });
  });
  it("parses futures + clamps leverage to 0.5 steps and 1..10", () => {
    expect(readMarketConfig('{"market":"FUTURES","leverage":3.4}').leverage).toBe(3.5);
    expect(readMarketConfig('{"market":"FUTURES","leverage":99}').leverage).toBe(10);
    expect(readMarketConfig('{"market":"FUTURES","leverage":0}').leverage).toBe(1);
  });
});

describe("liquidationPrice + futuresPnl", () => {
  it("computes liq distance = entry/leverage × buffer", () => {
    // 5× → 20% distance × 0.9 buffer = 18%
    expect(liquidationPrice(100, "LONG", 5)).toBeCloseTo(82, 5);
    expect(liquidationPrice(100, "SHORT", 5)).toBeCloseTo(118, 5);
  });
  it("pnl is direction-aware", () => {
    expect(futuresPnl(100, 110, 2, "LONG")).toBeCloseTo(20);
    expect(futuresPnl(100, 110, 2, "SHORT")).toBeCloseTo(-20);
  });
});

describe("backtest — futures", () => {
  it("opens a SHORT on SELL signal and profits from a decline", () => {
    // warmup 2 candles, SELL signal at i=2 → short at ~100, falls to 90, BUY closes
    const c = candles([100, 100, 100, 95, 92, 90, 90, 91, 92, 93]);
    const r = runBacktest({
      ...base, candles: c,
      market: "FUTURES", leverage: 2, takeProfitPct: 20,
      signalFn: seq({ 2: "SELL", 7: "BUY" }),
    });
    expect(r.totalTrades).toBe(1);
    const t = r.trades[0];
    expect(t.side).toBe("SELL");
    expect(t.exitReason).toBe("SIGNAL");
    // margin = 5000, notional = 10000 → amount ≈ 100; pnl = (entry-exit)*amount > 0
    expect(t.pnl).toBeGreaterThan(0);
    expect(t.pnlPct).toBeGreaterThan(0);
    expect(r.finalBalance).toBeGreaterThan(10_000);
  });

  it("leverage multiplies pnl vs margin", () => {
    const c = candles([100, 100, 100, 104, 108, 110, 110, 110, 110, 110]);
    const noLev = runBacktest({ ...base, candles: c, market: "FUTURES", leverage: 1, signalFn: seq({ 2: "BUY" }) });
    const lev = runBacktest({ ...base, candles: c, market: "FUTURES", leverage: 4, signalFn: seq({ 2: "BUY" }) });
    const last1 = noLev.trades.at(-1)!;
    const last2 = lev.trades.at(-1)!;
    // 4× notional on same margin → ~4× pnl (fee=0)
    expect(last2.pnl / last1.pnl).toBeCloseTo(4, 1);
  });

  it("liquidates on adverse move beyond the liq distance — loses margin", () => {
    // 5× → liq at ~18% below entry; candle lows engineered to reach it (low = close*0.999
    // isn't enough, so craft explicit candles)
    const px = [100, 100, 100, 99, 85, 80, 79, 79, 79, 79];
    const c: Candle[] = px.map((p, i) => ({ time: i * 60_000, open: p, high: p, low: p === 79 ? 77 : p, close: p, volume: 1 }));
    const r = runBacktest({
      ...base, candles: c,
      market: "FUTURES", leverage: 5, stopLossPct: 50, // wide stop → liq hits first
      signalFn: seq({ 2: "BUY" }),
    });
    expect(r.totalTrades).toBe(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe("LIQUIDATED");
    expect(t.pnl).toBeCloseTo(-t.amount * t.exitPrice * 0 - 5000, -3); // margin = 5000
    expect(t.pnlPct).toBe(-100);
  });

  it("spot mode stays long-only — SELL signal never opens a trade", () => {
    const c = candles([100, 100, 100, 95, 90, 88, 85, 84, 83, 82]);
    const r = runBacktest({ ...base, candles: c, market: "SPOT", signalFn: seq({ 2: "SELL", 5: "SELL" }) });
    expect(r.totalTrades).toBe(0);
  });

  it("short SL/TP are mirrored — SL above, TP below entry", () => {
    // short at 100 → rallies to 112 > SL(105) → stopped out
    const c = candles([100, 100, 100, 102, 104, 108, 112, 112, 112, 112]);
    const r = runBacktest({
      ...base, candles: c,
      market: "FUTURES", leverage: 2, stopLossPct: 5, takeProfitPct: 50,
      signalFn: seq({ 2: "SELL" }),
    });
    expect(r.totalTrades).toBe(1);
    expect(r.trades[0].exitReason).toBe("STOP_LOSS");
    expect(r.trades[0].pnl).toBeLessThan(0);
    // ~5% adverse on 2× exposure vs 5000 margin → ≈ -500
    expect(r.trades[0].pnl).toBeLessThan(-400);
  });

  it("opposite signal closes a long before opening anything new", () => {
    const c = candles([100, 100, 100, 103, 106, 104, 102, 101, 100, 99]);
    const r = runBacktest({
      ...base, candles: c,
      market: "FUTURES", leverage: 2,
      signalFn: seq({ 2: "BUY", 5: "SELL", 8: "SELL" }),
    });
    // first SELL closes the long; second SELL (flat now) opens a short → closed at END
    expect(r.totalTrades).toBe(2);
    expect(r.trades[0].side).toBe("BUY");
    expect(r.trades[0].exitReason).toBe("SIGNAL");
    expect(r.trades[1].side).toBe("SELL");
  });
});
