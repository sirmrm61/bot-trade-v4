import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { redisPing } from "@/infrastructure/redis/client";

export const GET = api(async () => {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const [
    totalUsers, activeUsers, expiredUsers, newUsers,
    totalCharges, sales, commissions,
    activeStrategies, openTrades, dailyTrades, apiErrors,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.userSubscription.count({ where: { status: { in: ["ACTIVE", "TRIAL"] }, expiresAt: { gt: new Date() } } }),
    prisma.userSubscription.count({ where: { status: { in: ["EXPIRED", "RESTRICTED", "GRACE_PERIOD"] } } }),
    prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.walletTransaction.aggregate({ where: { type: "CHARGE" }, _sum: { amount: true } }),
    prisma.strategyPurchase.aggregate({ _sum: { price: true } }),
    prisma.strategyPurchase.aggregate({ _sum: { commissionAmt: true } }),
    prisma.liveStrategy.count({ where: { status: { in: ["RUNNING", "PAUSED", "STARTING"] } } }),
    prisma.trade.count({ where: { status: "OPEN" } }),
    prisma.trade.count({ where: { openedAt: { gte: dayAgo } } }),
    prisma.order.count({ where: { status: { in: ["REJECTED", "ERROR"] }, createdAt: { gte: dayAgo } } }),
  ]);
  const walletTotal = await prisma.wallet.aggregate({ _sum: { balance: true } });

  return {
    users: { total: totalUsers, active: activeUsers, expired: expiredUsers, newToday: newUsers },
    finance: {
      walletBalances: walletTotal._sum.balance ?? 0,
      totalCharges: totalCharges._sum.amount ?? 0,
      marketplaceSales: sales._sum.price ?? 0,
      commission: commissions._sum.commissionAmt ?? 0,
    },
    trading: { activeStrategies, openTrades, dailyTrades, apiErrors },
    system: { redis: await redisPing() },
  };
}, { admin: true });
