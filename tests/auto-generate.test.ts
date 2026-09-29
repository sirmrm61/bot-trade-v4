import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/infrastructure/database/prisma";
import type { PairRank, RankResult } from "@/modules/scalping/types";
import type { Candle } from "@/modules/exchanges/types";

vi.mock("@/modules/scalping/service", () => ({ rankPairs: vi.fn() }));
vi.mock("@/modules/notifications/service", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/modules/pairs/service", () => ({
  getCandles: vi.fn(),
  tfMs: (tf: string) =>
    ({ "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 })[tf] ?? 3_600_000,
}));

const { rankPairs } = await import("@/modules/scalping/service");
const { getCandles } = await import("@/modules/pairs/service");
const { autoGenerateStrategies } = await import("@/modules/strategies/auto-generate");

const META: RankResult["meta"] = {
  generatedAt: Date.now(), source: "TEST", totalPairs: 0, ranked: 0,
  partial: 0, excluded: 0, noData: 0, usdIrtRate: null, disclaimer: "",
};

function mkPair(over: Partial<PairRank> & { symbol: string }): PairRank {
  return {
    baseCurrency: over.symbol.replace(/USDT|IRT|M$/g, ""),
    quoteCurrency: "USDT",
    exchange: "NOBITEX",
    marketType: "SPOT",
    status: "RANKED",
    score: 80,
    partial: false,
    reasons: [],
    criteria: [],
    metrics: { roundTripCostPct: 0.3, feePctPerSide: 0.15 },
    dataQuality: { completeness: 1, stale: [], issues: [] },
    updatedAt: Date.now(),
    ...over,
  };
}

function candles(n: number, vol = 0.01): Candle[] {
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + vol * Math.sin(i * 1.7);
    return { time: i * 60_000, open: p, high: p, low: p, close: p, volume: 100 };
  });
}

async function cleanup() {
  await prisma.strategy.deleteMany({ where: { name: { startsWith: "اسکالپ " } } });
}

describe("autoGenerateStrategies", () => {
  beforeEach(async () => {
    await cleanup();
    vi.mocked(getCandles).mockResolvedValue(candles(200));
  });

  it("creates 5 strategies from top-ranked pairs with signal defaults", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const pairs = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"].map((s, i) =>
      mkPair({ symbol: s, baseCurrency: s.slice(0, 3), score: 90 - i }),
    );
    vi.mocked(rankPairs).mockResolvedValue({ pairs, meta: { ...META, totalPairs: 100, ranked: 5 } });

    const res = await autoGenerateStrategies(user.id, { count: 5 });

    expect(res.created).toHaveLength(5);
    expect(res.skipped).toHaveLength(0);
    const created = await prisma.strategy.findMany({
      where: { id: { in: res.created.map((c) => c.id) } },
      include: { versions: { include: { indicators: true } } },
    });
    expect(created).toHaveLength(5);
    for (const s of created) {
      const v = s.versions[0];
      expect(s.origin).toBe("AI");
      expect(v.kind).toBe("SIGNAL");
      expect(v.timeframe).toBe("5m"); // equal edges → shortest tf wins
      const wSum = v.indicators.filter((i) => i.enabled).reduce((a, i) => a + i.weight, 0);
      expect(wSum).toBeCloseTo(1, 5);
    }
  });

  it("maps perpetuals to FUTURES + leverage and LIMIT when maker is cheaper", async () => {
    const user = await prisma.user.findFirstOrThrow();
    vi.mocked(rankPairs).mockResolvedValue({
      pairs: [
        mkPair({
          symbol: "AAAUSDTM", baseCurrency: "AAA", exchange: "KUCOIN",
          marketType: "PERPETUAL",
          metrics: { roundTripCostPct: 0.2, feePctPerSide: 0.2, makerFeePct: 0.05 },
        }),
      ],
      meta: { ...META, totalPairs: 10, ranked: 1 },
    });

    const res = await autoGenerateStrategies(user.id, { count: 5 });
    expect(res.created).toHaveLength(1);
    const v = await prisma.strategyVersion.findFirstOrThrow({
      where: { strategyId: res.created[0].id },
    });
    expect(v.orderType).toBe("LIMIT");
    const cfg = JSON.parse(v.config);
    expect(cfg.market).toBe("FUTURES");
    expect(cfg.leverage).toBe(2);
    expect(cfg.exchange).toBe("KUCOIN");
  });

  it("skips pairs that already have a strategy and duplicate base assets", async () => {
    const user = await prisma.user.findFirstOrThrow();
    // pre-existing strategy on TAKENUSDT
    await prisma.strategy.create({
      data: {
        userId: user.id, name: "اسکالپ TAKENUSDT — preexisting",
        versions: {
          create: {
            versionNumber: 1, kind: "SIGNAL", symbol: "TAKENUSDT", timeframe: "15m",
            buyThreshold: 0.35, sellThreshold: -0.35, riskPerTradePct: 1,
            stopLossPct: 1, takeProfitPct: 2, orderType: "MARKET",
            config: JSON.stringify({ exchange: "NOBITEX" }),
          },
        },
      },
    });
    vi.mocked(rankPairs).mockResolvedValue({
      pairs: [
        mkPair({ symbol: "TAKENUSDT", baseCurrency: "TAKEN", score: 95 }),
        mkPair({ symbol: "SAME-USDT", baseCurrency: "SAME", exchange: "KUCOIN", score: 90 }),
        mkPair({ symbol: "SAMEUSDTM", baseCurrency: "SAME", exchange: "KUCOIN", marketType: "PERPETUAL", score: 89 }),
        mkPair({ symbol: "OTHERUSDT", baseCurrency: "OTHER", score: 88 }),
      ],
      meta: { ...META, totalPairs: 50, ranked: 4 },
    });

    const res = await autoGenerateStrategies(user.id, { count: 5 });

    expect(res.created.map((c) => c.symbol)).toEqual(["SAME-USDT", "OTHERUSDT"]);
    expect(res.skipped.find((s) => s.symbol === "TAKENUSDT")?.reason).toContain("از قبل وجود دارد");
    expect(res.skipped.find((s) => s.symbol === "SAMEUSDTM")?.reason).toContain("تکراری");
  });

  it("skips pairs whose candles can't cover trading costs", async () => {
    const user = await prisma.user.findFirstOrThrow();
    vi.mocked(rankPairs).mockResolvedValue({
      pairs: [
        mkPair({ symbol: "FLATUSDT", baseCurrency: "FLAT", score: 90, metrics: { roundTripCostPct: 1.5 } }),
        mkPair({ symbol: "GOODUSDT", baseCurrency: "GOOD", score: 85 }),
      ],
      meta: { ...META, totalPairs: 50, ranked: 2 },
    });
    vi.mocked(getCandles).mockImplementation(async (opts: { symbol: string }) =>
      opts.symbol === "FLATUSDT" ? candles(200, 0) : candles(200),
    );

    const res = await autoGenerateStrategies(user.id, { count: 5 });
    expect(res.created.map((c) => c.symbol)).toEqual(["GOODUSDT"]);
    expect(res.skipped.find((s) => s.symbol === "FLATUSDT")?.reason).toContain("هزینه");
  });

  it("creates fewer than requested when not enough candidates survive", async () => {
    const user = await prisma.user.findFirstOrThrow();
    vi.mocked(rankPairs).mockResolvedValue({
      pairs: [mkPair({ symbol: "ONLYUSDT", baseCurrency: "ONLY" })],
      meta: { ...META, totalPairs: 30, ranked: 1 },
    });
    const res = await autoGenerateStrategies(user.id, { count: 5 });
    expect(res.created).toHaveLength(1);
    expect(res.created[0].symbol).toBe("ONLYUSDT");
  });
});
