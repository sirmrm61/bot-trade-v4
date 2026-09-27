import { describe, it, expect } from "vitest";
import { prisma } from "@/infrastructure/database/prisma";
import { deleteStrategy } from "@/modules/strategies/service";

function strategyData(userId: string, name: string) {
  return {
    userId, name, status: "LIVE",
    versions: {
      create: {
        versionNumber: 1, kind: "SIGNAL", symbol: "BTCIRT", timeframe: "1h",
        buyThreshold: 0.3, sellThreshold: -0.3, riskPerTradePct: 1,
        stopLossPct: 1, takeProfitPct: 2, maxPositionPct: 100, orderType: "MARKET",
        config: "{}",
      },
    },
  };
}

describe("deleteStrategy — parked live instances", () => {
  it("deletes strategy with DEGRADED live instance", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const s = await prisma.strategy.create({ data: strategyData(user.id, "tmp-del"), include: { versions: true } });
    const live = await prisma.liveStrategy.create({
      data: {
        userId: user.id, strategyId: s.id, versionId: s.versions[0].id,
        symbol: "BTCIRT", allocatedCapital: 1_000_000, status: "DEGRADED", mode: "PAPER",
      },
    });

    const res = await deleteStrategy(user.id, s.id);
    expect(res.soft).toBe(false);
    expect(await prisma.strategy.findUnique({ where: { id: s.id } })).toBeNull();
    expect(await prisma.liveStrategy.findUnique({ where: { id: live.id } })).toBeNull();
  });

  it("deletes strategy with PAUSED live instance", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const s = await prisma.strategy.create({ data: strategyData(user.id, "tmp-del3"), include: { versions: true } });
    await prisma.liveStrategy.create({
      data: {
        userId: user.id, strategyId: s.id, versionId: s.versions[0].id,
        symbol: "BTCIRT", allocatedCapital: 1_000_000, status: "PAUSED", mode: "PAPER",
      },
    });
    const res = await deleteStrategy(user.id, s.id);
    expect(res.soft).toBe(false);
    expect(await prisma.strategy.findUnique({ where: { id: s.id } })).toBeNull();
  });

  it("still blocks deletion while RUNNING", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const s = await prisma.strategy.create({ data: strategyData(user.id, "tmp-del2"), include: { versions: true } });
    await prisma.liveStrategy.create({
      data: {
        userId: user.id, strategyId: s.id, versionId: s.versions[0].id,
        symbol: "BTCIRT", allocatedCapital: 1_000_000, status: "RUNNING", mode: "PAPER",
      },
    });

    await expect(deleteStrategy(user.id, s.id)).rejects.toThrow("STRATEGY_HAS_LIVE");
    await prisma.liveStrategy.deleteMany({ where: { strategyId: s.id } });
    await prisma.strategy.delete({ where: { id: s.id } });
  });
});
