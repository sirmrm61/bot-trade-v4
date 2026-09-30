import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/infrastructure/database/prisma";
import type { Candle } from "@/modules/exchanges/types";
import type { PairRank, RankResult } from "@/modules/scalping/types";
import {
  detectDirection, dynamicStops, computeOpportunity, backtestScanner,
  OPPORTUNITY_DEFAULTS,
} from "@/modules/opportunity/engine";
import { checkPortfolioRisk, DEFAULT_PORTFOLIO_RISK } from "@/modules/opportunity/service";

vi.mock("@/modules/scalping/service", () => ({ rankPairs: vi.fn() }));
vi.mock("@/modules/pairs/service", () => ({
  getCandles: vi.fn(),
  tfMs: (tf: string) =>
    ({ "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 })[tf] ?? 3_600_000,
}));
vi.mock("@/modules/activity/service", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/infrastructure/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { rankPairs } = await import("@/modules/scalping/service");
const { getCandles } = await import("@/modules/pairs/service");
const { scanOpportunities } = await import("@/modules/opportunity/service");

const META: RankResult["meta"] = {
  generatedAt: Date.now(), source: "TEST", totalPairs: 1, ranked: 1,
  partial: 0, excluded: 0, noData: 0, usdIrtRate: null, disclaimer: "",
};

/** Trending candles — steady drift `dir` per bar with small noise. */
function trendCandles(n: number, dir: 1 | -1, start = 100): Candle[] {
  let p = start;
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + dir * 0.004 + 0.001 * Math.sin(i * 2.3);
    return { time: i * 60_000, open: p * 0.999, high: p * 1.003, low: p * 0.996, close: p, volume: 50 };
  });
}

/** Flat choppy candles — no directional edge. */
function flatCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = 100 + Math.sin(i * 0.9) * 0.05;
    return { time: i * 60_000, open: p, high: p * 1.0005, low: p * 0.9995, close: p, volume: 50 };
  });
}

function mkRank(over: Partial<PairRank> = {}): PairRank {
  return {
    symbol: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT",
    exchange: "KUCOIN", marketType: "SPOT", status: "RANKED",
    score: 78, partial: false, reasons: [], criteria: [],
    metrics: { mid: 101, roundTripCostPct: 0.5, feePctPerSide: 0.2 },
    dataQuality: { completeness: 1, stale: [], issues: [] },
    updatedAt: Date.now(),
    ...over,
  };
}

describe("opportunity engine — direction", () => {
  it("detects LONG on uptrend, SHORT on downtrend", () => {
    expect(detectDirection(trendCandles(80, 1))?.direction).toBe("LONG");
    expect(detectDirection(trendCandles(80, -1))?.direction).toBe("SHORT");
  });

  it("returns null on flat/choppy market (no fake signals)", () => {
    expect(detectDirection(flatCandles(80))).toBeNull();
    expect(detectDirection(trendCandles(10, 1))).toBeNull(); // too short
  });
});

describe("opportunity engine — dynamic stops", () => {
  const cfg = OPPORTUNITY_DEFAULTS;

  it("TP/SL scale with ATR — never a fixed percentage", () => {
    const calm = dynamicStops(trendCandles(80, 1), 0.3, cfg)!;
    const wild = trendCandles(80, 1).map((c, i) => ({
      ...c, high: c.high * (1 + 0.02 * Math.abs(Math.sin(i))), low: c.low * (1 - 0.02 * Math.abs(Math.sin(i))),
    }));
    const wildStops = dynamicStops(wild, 0.3, cfg)!;
    expect(wildStops.atrPct).toBeGreaterThan(calm.atrPct);
    expect(wildStops.tpPct).toBeGreaterThan(calm.tpPct);
  });

  it("TP always clears round-trip cost with margin", () => {
    const s = dynamicStops(trendCandles(80, 1), 0.8, cfg)!;
    expect(s.tpPct).toBeGreaterThanOrEqual(0.8 * 2 - 0.001);
    expect(s.slPct).toBeGreaterThan(0);
  });
});

describe("opportunity engine — opportunity acceptance", () => {
  it("accepts a trending pair with sane cost → full trade plan", () => {
    const calc = computeOpportunity({
      candles: trendCandles(80, 1), costPct: 0.3, scanScore: 80, mid: 101,
    });
    expect(calc).not.toBeNull();
    expect(calc!.direction).toBe("LONG");
    expect(calc!.takeProfitPrice).toBeGreaterThan(calc!.entryPrice);
    expect(calc!.stopLossPrice).toBeLessThan(calc!.entryPrice);
    expect(calc!.netReturnPct).toBeGreaterThan(0);
    expect(calc!.riskReward).toBeGreaterThanOrEqual(OPPORTUNITY_DEFAULTS.minRiskReward);
    expect(calc!.score).toBeGreaterThan(0);
    expect(calc!.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects when cost eats the edge (cost-dominated)", () => {
    expect(computeOpportunity({
      candles: trendCandles(80, 1), costPct: 6, scanScore: 80, mid: 101,
    })).toBeNull();
  });

  it("rejects flat markets — no direction, no opportunity", () => {
    expect(computeOpportunity({
      candles: flatCandles(80), costPct: 0.3, scanScore: 90, mid: 100,
    })).toBeNull();
  });

  it("SHORT plan mirrors price levels below entry", () => {
    const calc = computeOpportunity({
      candles: trendCandles(80, -1), costPct: 0.3, scanScore: 70, mid: 99,
    });
    expect(calc).not.toBeNull();
    expect(calc!.direction).toBe("SHORT");
    expect(calc!.takeProfitPrice).toBeLessThan(calc!.entryPrice);
    expect(calc!.stopLossPrice).toBeGreaterThan(calc!.entryPrice);
  });
});

describe("opportunity engine — scanner backtest", () => {
  it("replays the same logic on history and applies costs", () => {
    const candles = trendCandles(400, 1);
    const res = backtestScanner({ candles, costPct: 0.5 });
    expect(res.totalSignals).toBeGreaterThan(0);
    expect(res.wins + res.losses + res.timeouts).toBe(res.totalSignals);
    // wins pay cost — avg PnL of a win < raw TP distance
    expect(res.avgPnlPct).toBeLessThan(10);
  });

  it("costlier market produces strictly lower total PnL", () => {
    const candles = trendCandles(400, 1);
    const cheap = backtestScanner({ candles, costPct: 0.1 });
    const dear = backtestScanner({ candles, costPct: 1.5 });
    expect(dear.totalPnlPct).toBeLessThanOrEqual(cheap.totalPnlPct);
  });

  it("flat market produces zero or few signals", () => {
    const res = backtestScanner({ candles: flatCandles(400), costPct: 0.3 });
    expect(res.totalSignals).toBe(0);
  });
});

describe("portfolio risk guard", () => {
  it("approves a clean book for a fresh user", async () => {
    const r = await checkPortfolioRisk("u-test-clean-" + Date.now(), { symbol: "BTC-USDT", exchange: "KUCOIN" });
    expect(r.approved).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("emergency stop vetoes everything", async () => {
    const r = await checkPortfolioRisk(
      "u-test-emg-" + Date.now(),
      { symbol: "BTC-USDT", exchange: "KUCOIN" },
      { ...DEFAULT_PORTFOLIO_RISK, emergencyStop: true },
    );
    expect(r.approved).toBe(false);
    expect(r.violations).toContain("EMERGENCY_STOP");
  });
});

describe("scanOpportunities — persistence", () => {
  beforeEach(async () => {
    await prisma.opportunity.deleteMany({ where: { userId: "u-opp-test" } });
    vi.clearAllMocks();
  });

  it("persists opportunities with plan, reasons and feature snapshot", async () => {
    vi.mocked(rankPairs).mockResolvedValue({ pairs: [mkRank()], meta: META });
    vi.mocked(getCandles).mockResolvedValue(trendCandles(120, 1));

    const res = await scanOpportunities("u-opp-test", { market: "SPOT", count: 5 });
    expect(res.created).toBe(1);

    const row = await prisma.opportunity.findFirst({ where: { userId: "u-opp-test" } });
    expect(row).not.toBeNull();
    expect(row!.direction).toBe("LONG");
    expect(row!.takeProfitPrice).toBeGreaterThan(row!.entryPrice);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(row!.createdAt.getTime());
    const feats = JSON.parse(row!.features);
    expect(feats.metrics.roundTripCostPct).toBe(0.5);
    const reasons = JSON.parse(row!.reasons);
    expect(reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("skips pairs with too little candle history", async () => {
    vi.mocked(rankPairs).mockResolvedValue({ pairs: [mkRank()], meta: META });
    vi.mocked(getCandles).mockResolvedValue(trendCandles(20, 1));
    const res = await scanOpportunities("u-opp-test", { count: 5 });
    expect(res.created).toBe(0);
  });

  it("passes market filter to the underlying scanner", async () => {
    vi.mocked(rankPairs).mockResolvedValue({ pairs: [], meta: { ...META, ranked: 0 } });
    await expect(scanOpportunities("u-opp-test", { market: "PERPETUAL" })).rejects.toThrow();
    expect(vi.mocked(rankPairs)).toHaveBeenCalledWith({ market: "PERPETUAL" });
  });
});
