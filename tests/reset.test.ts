import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/infrastructure/database/prisma";
import { resetTestData } from "@/modules/account/reset";

const RUN = `rst-${Date.now()}`;
let userId = "";

async function mkStrategy(name: string) {
  return prisma.strategy.create({
    data: {
      userId, name, status: "LIVE",
      versions: {
        create: {
          versionNumber: 1, kind: "SIGNAL", symbol: "BTCIRT", timeframe: "1h",
          buyThreshold: 0.3, sellThreshold: -0.3, riskPerTradePct: 1,
          stopLossPct: 1, takeProfitPct: 2, maxPositionPct: 100, orderType: "MARKET",
          config: "{}",
        },
      },
    },
    include: { versions: true },
  });
}

async function mkLive(strategyId: string, versionId: string, mode: "PAPER" | "REAL") {
  return prisma.liveStrategy.create({
    data: { userId, strategyId, versionId, symbol: "BTCIRT", allocatedCapital: 1_000_000, status: "RUNNING", mode },
  });
}

/** Full user wipe — several user relations are Restrict, not Cascade. */
async function wipeUser(uid: string) {
  await prisma.signalLog.deleteMany({ where: { userId: uid } });
  await prisma.order.deleteMany({ where: { userId: uid } });
  await prisma.trade.deleteMany({ where: { userId: uid } });
  await prisma.liveStrategy.deleteMany({ where: { userId: uid } });
  await prisma.backtest.deleteMany({ where: { userId: uid } });
  await prisma.opportunity.deleteMany({ where: { userId: uid } });
  await prisma.whaleEvent.deleteMany({ where: { userId: uid } });
  await prisma.tradingAgent.deleteMany({ where: { userId: uid } });
  await prisma.user.delete({ where: { id: uid } });
}

afterAll(async () => {
  if (userId) await wipeUser(userId).catch(() => {});
});

describe("resetTestData", () => {
  it("wipes paper data, keeps REAL live strategy + its trade", { timeout: 60_000 }, async () => {
    const user = await prisma.user.create({
      data: { username: RUN, passwordHash: "x", referralCode: RUN },
    });
    userId = user.id;

    // paper live + open trade + order + signal log
    const paperStrategy = await mkStrategy(`${RUN}-paper`);
    const paperLive = await mkLive(paperStrategy.id, paperStrategy.versions[0].id, "PAPER");
    const paperTrade = await prisma.trade.create({
      data: { userId, liveStrategyId: paperLive.id, symbol: "BTCIRT", entryPrice: 100, amount: 1, invested: 100 },
    });
    await prisma.order.create({
      data: { userId, liveStrategyId: paperLive.id, tradeId: paperTrade.id, symbol: "BTCIRT", side: "BUY", type: "MARKET", amount: 1, idempotencyKey: `${RUN}-o1` },
    });
    await prisma.signalLog.create({
      data: { userId, liveStrategyId: paperLive.id, exchange: "NOBITEX", symbol: "BTCIRT", kind: "SIGNAL", signal: "BUY", decision: "ENTERED", features: "{}" },
    });

    // real live + trade — must survive
    const realStrategy = await mkStrategy(`${RUN}-real`);
    const realLive = await mkLive(realStrategy.id, realStrategy.versions[0].id, "REAL");
    const realTrade = await prisma.trade.create({
      data: { userId, liveStrategyId: realLive.id, symbol: "BTCIRT", entryPrice: 100, amount: 1, invested: 100 },
    });

    // backtest + scanner artifacts + an orphan strategy
    const bt = await prisma.backtest.create({
      data: {
        userId, strategyId: paperStrategy.id, symbol: "BTCIRT", timeframe: "1h",
        startDate: new Date(), endDate: new Date(), initialBalance: 1000, status: "COMPLETED",
      },
    });
    await prisma.opportunity.create({
      data: {
        userId, exchange: "KUCOIN", symbol: "BTCUSDTM", marketType: "SPOT", direction: "LONG",
        timeframe: "5m", entryPrice: 1, stopLossPct: 1, takeProfitPct: 2, stopLossPrice: 1, takeProfitPrice: 1,
        grossReturnPct: 2, totalCostPct: 0.5, netReturnPct: 1.5, riskReward: 2, score: 80,
        reasons: "[]", features: "{}", expiresAt: new Date(),
      },
    });
    await prisma.whaleEvent.create({
      data: { userId, exchange: "KUCOIN", symbol: "BTCUSDTM", marketType: "SPOT", kind: "BID_WALL", mid: 1, bidDepthUsd: 1, askDepthUsd: 1, imbalance: 2, score: 80, reasons: "[]", features: "{}" },
    });
    const orphan = await mkStrategy(`${RUN}-orphan`);

    // legacy orphan trade (liveStrategyId NULL) + its order — must be wiped
    const orphanTrade = await prisma.trade.create({
      data: { userId, symbol: "BTCUSDT", entryPrice: 100, amount: 1, invested: 100, status: "CLOSED" },
    });
    await prisma.order.create({
      data: { userId, tradeId: orphanTrade.id, symbol: "BTCUSDT", side: "BUY", type: "MARKET", amount: 1, idempotencyKey: `${RUN}-o2` },
    });

    // PAPER agent (test artifact — must go) + REAL agent (must stay)
    const paperAgent = await prisma.tradingAgent.create({
      data: { userId, symbol: "AVA-USDT", mode: "PAPER" },
    });
    const realAgent = await prisma.tradingAgent.create({
      data: { userId, symbol: "BTC-USDT", mode: "REAL" },
    });

    const s = await resetTestData(userId);

    expect(s.stoppedPaperLives).toBe(1);
    expect(s.deletedBacktests).toBe(1);
    expect(s.deletedTrades).toBe(2); // paper trade + orphan trade
    expect(s.deletedOrders).toBe(2);
    expect(s.deletedSignalLogs).toBe(1);
    expect(s.deletedOpportunities).toBe(1);
    expect(s.deletedWhaleEvents).toBe(1);
    expect(s.deletedStrategies).toBe(2); // paper + orphan
    expect(s.deletedAgents).toBe(1); // PAPER agent removed

    expect(await prisma.liveStrategy.findUnique({ where: { id: paperLive.id } })).toBeNull();
    expect(await prisma.trade.findUnique({ where: { id: paperTrade.id } })).toBeNull();
    expect(await prisma.trade.findUnique({ where: { id: orphanTrade.id } })).toBeNull();
    expect(await prisma.tradingAgent.findUnique({ where: { id: paperAgent.id } })).toBeNull();
    expect(await prisma.tradingAgent.findUnique({ where: { id: realAgent.id } })).not.toBeNull();
    expect(await prisma.backtest.findUnique({ where: { id: bt.id } })).toBeNull();
    expect(await prisma.strategy.findUnique({ where: { id: orphan.id } })).toBeNull();
    expect(await prisma.strategy.findUnique({ where: { id: paperStrategy.id } })).toBeNull();

    // REAL side untouched
    const keptLive = await prisma.liveStrategy.findUnique({ where: { id: realLive.id } });
    expect(keptLive?.status).toBe("RUNNING");
    expect(await prisma.trade.findUnique({ where: { id: realTrade.id } })).not.toBeNull();
    expect(await prisma.strategy.findUnique({ where: { id: realStrategy.id } })).not.toBeNull();
  });

  it("does not touch other users' data", { timeout: 60_000 }, async () => {
    const other = await prisma.user.create({
      data: { username: `${RUN}-b`, passwordHash: "x", referralCode: `${RUN}-b` },
    });
    try {
      const s = await prisma.strategy.create({
        data: {
          userId: other.id, name: `${RUN}-other`, status: "LIVE",
          versions: {
            create: {
              versionNumber: 1, kind: "SIGNAL", symbol: "BTCIRT", timeframe: "1h",
              buyThreshold: 0.3, sellThreshold: -0.3, riskPerTradePct: 1,
              stopLossPct: 1, takeProfitPct: 2, maxPositionPct: 100, orderType: "MARKET",
              config: "{}",
            },
          },
        },
        include: { versions: true },
      });
      const live = await prisma.liveStrategy.create({
        data: { userId: other.id, strategyId: s.id, versionId: s.versions[0].id, symbol: "BTCIRT", allocatedCapital: 1, status: "RUNNING", mode: "PAPER" },
      });
      await prisma.backtest.create({
        data: {
          userId: other.id, strategyId: s.id, symbol: "BTCIRT", timeframe: "1h",
          startDate: new Date(), endDate: new Date(), initialBalance: 1, status: "COMPLETED",
        },
      });

      await resetTestData(userId); // user 1 again — user 2 must be untouched

      expect((await prisma.liveStrategy.findUnique({ where: { id: live.id } }))?.status).toBe("RUNNING");
      expect(await prisma.strategy.findUnique({ where: { id: s.id } })).not.toBeNull();
      expect(await prisma.backtest.count({ where: { userId: other.id } })).toBe(1);
    } finally {
      await wipeUser(other.id).catch(() => {});
    }
  });
});
