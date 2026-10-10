import { describe, it, expect } from "vitest";
import { runBacktest } from "@/modules/backtest/engine";
import { extendedMetrics, acceptanceCheck } from "@/modules/backtest/metrics";
import { entryQuality, resample } from "@/modules/signals/quality";
import type { Candle } from "@/modules/exchanges/types";

/** synthetic candle series from closes — mild noise on high/low */
function trend(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: i * 900_000, open: c * 0.999, high: c * 1.004, low: c * 0.996, close: c, volume: 100 + (i % 7) * 10,
  }));
}

describe("entryQuality — signal scoring", () => {
  const uptrend = trend(Array.from({ length: 200 }, (_, i) => 100 + i * 0.4));
  const downtrend = trend(Array.from({ length: 200 }, (_, i) => 180 - i * 0.4));
  const flat = trend(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 0.5));

  it("scores a with-trend long higher than an against-trend long", () => {
    const good = entryQuality(uptrend, "LONG");
    const bad = entryQuality(downtrend, "LONG");
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.score).toBeGreaterThanOrEqual(0.5);
  });

  it("reports regime + component breakdown", () => {
    const q = entryQuality(uptrend, "LONG");
    expect(q.components).toHaveProperty("trend");
    expect(q.components).toHaveProperty("rsi");
    expect(q.regime).toBeDefined();
  });

  it("ranging markets score below trending ones", () => {
    const r = entryQuality(flat, "LONG");
    const t = entryQuality(uptrend, "LONG");
    expect(r.score).toBeLessThan(t.score);
  });

  it("resample aggregates candles", () => {
    const htf = resample(trend(Array.from({ length: 40 }, () => 100)), 4);
    expect(htf.length).toBe(10);
    expect(htf[0].volume).toBeGreaterThan(0);
  });
});

describe("extendedMetrics + acceptanceCheck", () => {
  const closes = [
    ...Array.from({ length: 80 }, (_, i) => 100 - i * 0.5),
    ...Array.from({ length: 60 }, (_, i) => 60 + i * 0.8),
    ...Array.from({ length: 60 }, (_, i) => 108 - i * 0.5),
  ];
  const result = runBacktest({
    candles: trend(closes),
    indicators: [
      { name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true,
        buyCondition: JSON.stringify({ op: "lt", value: 35 }),
        sellCondition: JSON.stringify({ op: "gt", value: 65 }) },
    ],
    buyThreshold: 0.5, sellThreshold: -0.5,
    initialBalance: 10_000,
    riskPerTradePct: 50, stopLossPct: 2, takeProfitPct: 5,
    trailingStop: false,
    feePct: 0.25, slippagePct: 0.05,
    minCandles: 30,
  });

  it("computes extended metrics", () => {
    const m = extendedMetrics(result);
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(Number.isFinite(m.sortino)).toBe(true);
    expect(Number.isFinite(m.expectancy)).toBe(true);
    expect(m.days).toBeGreaterThan(0);
    expect(m.maxConsecLosses).toBeGreaterThanOrEqual(0);
  });

  it("acceptance gate rejects weak evidence", () => {
    const m = extendedMetrics(result);
    const weak = acceptanceCheck(m, { ...m, totalTrades: 5 });
    expect(weak.passed).toBe(false);
    const noExpectancy = acceptanceCheck(m, { ...m, expectancy: -0.1 });
    expect(noExpectancy.passed).toBe(false);
  });

  it("acceptance gate flags overfit degradation", () => {
    const m = extendedMetrics({ ...result, totalTrades: 40, profitFactor: 2 });
    const check = acceptanceCheck(m, { ...m, profitFactor: 0.9 });
    expect(check.passed).toBe(false);
    expect(check.reasons.some((r) => r.includes("اورفیت"))).toBe(true);
  });
});

describe("partial take-profit in the engine", () => {
  const closes = [
    ...Array.from({ length: 80 }, (_, i) => 100 - i * 0.5),   // dip → oversold
    ...Array.from({ length: 120 }, (_, i) => 60 + i * 0.8),   // strong rally
  ];
  const base = {
    candles: trend(closes),
    indicators: [
      { name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true,
        buyCondition: JSON.stringify({ op: "lt", value: 35 }),
        sellCondition: JSON.stringify({ op: "gt", value: 70 }) },
    ],
    buyThreshold: 0.5, sellThreshold: -0.5,
    initialBalance: 10_000, riskPerTradePct: 50,
    stopLossPct: 3, takeProfitPct: 4,
    trailingStop: false, feePct: 0.25, slippagePct: 0.05,
    minCandles: 30,
  };

  it("emits PARTIAL_TP trades and banks profit at the TP level", () => {
    const r = runBacktest({ ...base, partialTakeProfit: { closeFrac: 0.5 } });
    const partials = r.trades.filter((t) => t.exitReason === "PARTIAL_TP");
    expect(partials.length).toBeGreaterThan(0);
    // partial fills land near entry + tpPct
    for (const t of partials) {
      expect(t.exitPrice).toBeGreaterThan(t.entryPrice);
    }
  });

  it("without the flag, TAKE_PROFIT exits as before", () => {
    const r = runBacktest(base);
    expect(r.trades.filter((t) => t.exitReason === "PARTIAL_TP").length).toBe(0);
  });
});
