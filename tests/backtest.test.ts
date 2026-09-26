import { describe, it, expect } from "vitest";
import { runBacktest } from "@/modules/backtest/engine";
import type { Candle } from "@/modules/exchanges/types";

function trend(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ time: i * 3_600_000, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1 }));
}

describe("backtest engine", () => {
  // dip then rally → RSI oversold buy, then sell on reversal
  const closes = [
    ...Array.from({ length: 80 }, (_, i) => 100 - i * 0.5),   // downtrend → RSI oversold
    ...Array.from({ length: 60 }, (_, i) => 60 + i * 0.8),     // rally
    ...Array.from({ length: 40 }, (_, i) => 108 - i * 1.5),    // dump
  ];
  const c = trend(closes);

  const result = runBacktest({
    candles: c,
    indicators: [
      { name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true,
        buyCondition: JSON.stringify({ op: "lt", value: 35 }),
        sellCondition: JSON.stringify({ op: "gt", value: 65 }) },
    ],
    buyThreshold: 0.5, sellThreshold: -0.5,
    initialBalance: 10_000_000,
    riskPerTradePct: 50, stopLossPct: 2, takeProfitPct: 5,
    trailingStop: false,
    feePct: 0.25, slippagePct: 0.05,
    minCandles: 30,
  });

  it("executes trades", () => {
    expect(result.totalTrades).toBeGreaterThan(0);
  });

  it("computes all required metrics", () => {
    for (const k of ["finalBalance", "netProfit", "profitPct", "winRate", "lossRate",
      "totalTrades", "winningTrades", "losingTrades", "avgProfit", "avgLoss",
      "maxDrawdown", "profitFactor", "largestWin", "largestLoss",
      "avgTradeDurationMin"] as const) {
      expect(result[k]).not.toBeNull();
      expect(Number.isFinite(result[k] as number)).toBe(true);
    }
    expect(result.equityCurve.length).toBeGreaterThan(0);
  });

  it("fee reduces balance on every trade", () => {
    for (const t of result.trades) expect(t.fee).toBeGreaterThan(0);
  });

  it("balance never goes negative", () => {
    for (const p of result.equityCurve) expect(p.equity).toBeGreaterThan(0);
  });

  it("ATR-based stops override pct stops", () => {
    const r = runBacktest({
      candles: c,
      indicators: [
        { name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true,
          buyCondition: JSON.stringify({ op: "lt", value: 35 }),
          sellCondition: JSON.stringify({ op: "gt", value: 65 }) },
      ],
      buyThreshold: 0.5, sellThreshold: -0.5,
      initialBalance: 10_000_000,
      riskPerTradePct: 50, stopLossPct: 2, takeProfitPct: 5,
      atrStops: { period: 14, slMultiplier: 1.5, tpMultiplier: 3 },
      trailingStop: false,
      feePct: 0.25, slippagePct: 0.05,
      minCandles: 30,
    });
    expect(r.totalTrades).toBeGreaterThan(0);
    for (const t of r.trades) expect(Number.isFinite(t.exitPrice)).toBe(true);
  });
});
