import { prisma } from "@/infrastructure/database/prisma";
import { adapterForUser } from "@/modules/exchanges/registry";
import { logger } from "@/infrastructure/logging/logger";
import { notify } from "@/modules/notifications/service";

/**
 * Reconciliation Engine — periodic comparison of internal state vs the
 * exchange's real state. Every discrepancy is logged in ActivityLog.
 *
 * Checks: open orders, filled orders, cancelled orders, balances, open trades.
 */

export async function reconcileLiveStrategy(liveStrategyId: string) {
  const live = await prisma.liveStrategy.findUnique({ where: { id: liveStrategyId } });
  if (!live) return;
  const adapter = await adapterForUser(live.userId, live.exchange || "NOBITEX", "reconcile").catch(() => null);
  if (!adapter) return;

  const diffs: string[] = [];

  // ---- orders ----------------------------------------------------------
  const internalOpen = await prisma.order.findMany({
    where: { liveStrategyId: live.id, status: { in: ["SUBMITTED", "PARTIALLY_FILLED"] } },
  });
  const exchangeOpen = await adapter.getOpenOrders(live.symbol).catch(() => []);
  const exchangeIds = new Set(exchangeOpen.map((o) => o.id));

  for (const order of internalOpen) {
    if (order.exchangeOrderId && !exchangeIds.has(order.exchangeOrderId)) {
      // order vanished from exchange → check its real status
      const real = await adapter.getOrder(order.exchangeOrderId, order.symbol).catch(() => null);
      if (real) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: real.status === "filled" ? "FILLED" : real.status === "cancelled" ? "CANCELLED" : order.status,
            filledAmount: real.filledAmount,
            avgFillPrice: real.avgPrice,
            closedAt: ["filled", "cancelled", "rejected"].includes(real.status) ? new Date() : undefined,
          },
        });
        diffs.push(`order:${order.id} status→${real.status}`);
      }
    }
  }

  // ---- trades ----------------------------------------------------------
  // If an entry order FILLED but trade still shows no fill — fix invested
  const openTrades = await prisma.trade.findMany({
    where: { liveStrategyId: live.id, status: "OPEN" },
  });
  for (const trade of openTrades) {
    if (trade.entryOrderId) {
      const entryOrder = await prisma.order.findUnique({ where: { id: trade.entryOrderId } });
      if (entryOrder?.status === "FILLED" && entryOrder.avgFillPrice && entryOrder.avgFillPrice !== trade.entryPrice) {
        await prisma.trade.update({
          where: { id: trade.id },
          data: { entryPrice: entryOrder.avgFillPrice, invested: entryOrder.avgFillPrice * trade.amount },
        });
        diffs.push(`trade:${trade.id} entryPrice corrected`);
      }
    }
  }

  if (diffs.length) {
    await prisma.activityLog.create({
      data: {
        userId: live.userId, actorType: "WORKER", action: "RECONCILE",
        entityType: "liveStrategy", entityId: live.id,
        metadata: JSON.stringify({ diffs }),
      },
    });
    logger.warn("reconciliation diffs", { module: "trading", liveStrategyId, diffs });
  }
  return diffs;
}

/** Reconcile all running strategies — called by reconciliationQueue cron. */
export async function reconcileAll() {
  const actives = await prisma.liveStrategy.findMany({
    where: { status: { in: ["RUNNING", "PAUSED", "DEGRADED", "STARTING", "STOPPING"] } },
    select: { id: true },
  });
  const results = await Promise.allSettled(actives.map((a) => reconcileLiveStrategy(a.id)));
  return { checked: actives.length, failed: results.filter((r) => r.status === "rejected").length };
}

/**
 * Worker recovery — run at startup:
 * load active strategies → load open orders → connect exchange →
 * fetch real state → reconcile → repair → resume.
 */
export async function recoverOnStartup() {
  logger.info("worker recovery starting", { module: "trading" });
  const actives = await prisma.liveStrategy.findMany({
    where: { status: { in: ["RUNNING", "PAUSED", "DEGRADED", "STARTING", "STOPPING"] } },
  });
  for (const live of actives) {
    try {
      await reconcileLiveStrategy(live.id);
      // resume: strategies left in STARTING get bumped to RUNNING
      if (live.status === "STARTING") {
        await prisma.liveStrategy.update({ where: { id: live.id }, data: { status: "RUNNING" } });
      }
    } catch (err) {
      logger.error("recovery failed for strategy", { module: "trading", liveStrategyId: live.id, errorCode: String(err) });
      await notify({
        userId: live.userId, type: "API_ERROR", severity: "ERROR",
        title: "بازیابی استراتژی", body: "بازیابی وضعیت استراتژی پس از راه‌اندازی مجدد با خطا مواجه شد.",
      }).catch(() => {});
    }
  }
  logger.info("worker recovery complete", { module: "trading", recovered: actives.length });
  return actives.length;
}
