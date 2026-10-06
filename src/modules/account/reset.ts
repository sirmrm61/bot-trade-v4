import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";

export interface ResetSummary {
  stoppedPaperLives: number;
  deletedTrades: number;
  deletedOrders: number;
  deletedSignalLogs: number;
  deletedBacktests: number;
  deletedOpportunities: number;
  deletedWhaleEvents: number;
  deletedStrategies: number;
  keptStrategies: number;
  deletedAgents: number;
}

/**
 * Wipe all test/paper data for a user — keeps REAL live strategies and their
 * orders/trades untouched.
 *
 * Order of operations matters: paper live strategies are marked STOPPED first
 * so the worker's tick scheduler stops enqueueing them, then their dependent
 * rows go before the strategy rows (FK), and strategies are only deleted when
 * no live strategy / marketplace listing still references them.
 */
export async function resetTestData(userId: string): Promise<ResetSummary> {
  // ---- stop paper lives first — scheduler drops STOPPED rows next tick
  const paperLives = await prisma.liveStrategy.findMany({
    where: { userId, mode: "PAPER" },
    select: { id: true },
  });
  const paperIds = paperLives.map((l) => l.id);
  const stopped = await prisma.liveStrategy.updateMany({
    where: { id: { in: paperIds }, status: { notIn: ["STOPPED", "ERROR"] } },
    data: { status: "STOPPED", stoppedAt: new Date() },
  });

  const paperTrades = await prisma.trade.findMany({
    where: { liveStrategyId: { in: paperIds } },
    select: { id: true },
  });
  const paperTradeIds = paperTrades.map((t) => t.id);

  // ---- dependent rows → then the rows they point at
  const signalLogs = await prisma.signalLog.deleteMany({
    where: {
      OR: [
        { liveStrategyId: { in: paperIds } },
        { tradeId: { in: paperTradeIds } },
      ],
    },
  });
  const orders = await prisma.order.deleteMany({ where: { liveStrategyId: { in: paperIds } } });
  const trades = await prisma.trade.deleteMany({ where: { liveStrategyId: { in: paperIds } } });
  await prisma.liveStrategy.deleteMany({ where: { id: { in: paperIds } } });

  // ---- orphan leftovers: legacy/unglued rows not attached to a REAL live.
  // `liveStrategyId NOT IN realIds` misses NULLs in SQL — the OR covers them.
  const realIds = (await prisma.liveStrategy.findMany({
    where: { userId, mode: "REAL" }, select: { id: true },
  })).map((l) => l.id);
  const notReal = { OR: [{ liveStrategyId: null }, { liveStrategyId: { notIn: realIds } }] };

  const orphanTradeIds = (await prisma.trade.findMany({
    where: { userId, ...notReal }, select: { id: true },
  })).map((t) => t.id);
  const orphanLogs = await prisma.signalLog.deleteMany({
    where: { userId, OR: [{ tradeId: { in: orphanTradeIds } }, ...notReal.OR] },
  });
  const orphanOrders = await prisma.order.deleteMany({
    where: { userId, OR: [{ tradeId: { in: orphanTradeIds } }, ...notReal.OR] },
  });
  const orphanTrades = await prisma.trade.deleteMany({ where: { userId, ...notReal } });

  // ---- paper agents are test artifacts too — remove so they can't recreate
  // strategies/trades after the reset (agent logs cascade).
  const agents = await prisma.tradingAgent.deleteMany({ where: { userId, mode: "PAPER" } });

  // ---- backtests (trades + trace events cascade) and orphan scan traces
  const backtests = await prisma.backtest.deleteMany({ where: { userId } });
  await prisma.traceEvent.deleteMany({ where: { backtestId: null } }); // scanner traces aren't user-scoped

  // ---- smart-trader test artifacts
  const opportunities = await prisma.opportunity.deleteMany({ where: { userId } });
  const whaleEvents = await prisma.whaleEvent.deleteMany({ where: { userId } });

  // ---- strategies: delete only those no live/marketplace row still needs.
  // Per-row try/catch — a purchase can still pin a version via FK.
  const candidates = await prisma.strategy.findMany({
    where: { userId, liveStrategies: { none: {} }, listings: { none: {} } },
    select: { id: true },
  });
  let deletedStrategies = 0;
  for (const s of candidates) {
    try {
      await prisma.strategy.delete({ where: { id: s.id } });
      deletedStrategies += 1;
    } catch {
      // referenced elsewhere (e.g. marketplace purchase) — keep it
    }
  }

  const summary: ResetSummary = {
    stoppedPaperLives: stopped.count,
    deletedTrades: trades.count + orphanTrades.count,
    deletedOrders: orders.count + orphanOrders.count,
    deletedSignalLogs: signalLogs.count + orphanLogs.count,
    deletedBacktests: backtests.count,
    deletedOpportunities: opportunities.count,
    deletedWhaleEvents: whaleEvents.count,
    deletedStrategies,
    keptStrategies: candidates.length - deletedStrategies,
    deletedAgents: agents.count,
  };
  logger.info("test data reset", { module: "account", userId, ...summary });
  return summary;
}
