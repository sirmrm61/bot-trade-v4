import { Card, CardTitle, PageHeader, StatCard } from "@/components/ui";
import { toman, faNumber } from "@/shared/utils";
import { prisma } from "@/infrastructure/database/prisma";
import { redisPing } from "@/infrastructure/redis/client";
import { HealthChecks } from "./health";

async function loadAdminStats() {
  const dayAgo = new Date(Date.now() - 86_400_000);
  return Promise.all([
    prisma.user.count(),
    prisma.userSubscription.count({ where: { status: { in: ["ACTIVE", "TRIAL"] }, expiresAt: { gt: new Date() } } }),
    prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.walletTransaction.aggregate({ where: { type: "CHARGE" }, _sum: { amount: true } }),
    prisma.strategyPurchase.aggregate({ _sum: { price: true } }),
    prisma.strategyPurchase.aggregate({ _sum: { commissionAmt: true } }),
    prisma.liveStrategy.count({ where: { status: { in: ["RUNNING", "PAUSED", "STARTING"] } } }),
    prisma.trade.count({ where: { status: "OPEN" } }),
    prisma.trade.count({ where: { openedAt: { gte: dayAgo } } }),
    prisma.order.count({ where: { status: { in: ["REJECTED", "ERROR"] }, createdAt: { gte: dayAgo } } }),
    prisma.wallet.aggregate({ _sum: { balance: true } }),
    redisPing(),
  ]);
}

export default async function AdminDashboard() {
  const [
    totalUsers, activeSubs, newUsers, charges, sales, commissions,
    activeStrategies, openTrades, dailyTrades, apiErrors, walletSum, redisOk,
  ] = await loadAdminStats();

  return (
    <div>
      <PageHeader title="داشبورد مدیریت" />

      <CardTitle>کاربران</CardTitle>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="کل کاربران" value={faNumber(totalUsers)} />
        <StatCard label="اشتراک فعال" value={faNumber(activeSubs)} tone="success" />
        <StatCard label="کاربران جدید (۲۴س)" value={faNumber(newUsers)} />
        <StatCard label="Redis" value={redisOk ? "متصل" : "قطع"} tone={redisOk ? "success" : "danger"} />
      </div>

      <CardTitle>مالی</CardTitle>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="موجودی کل کیف پول‌ها" value={toman(walletSum._sum.balance ?? 0)} />
        <StatCard label="کل شارژها" value={toman(charges._sum.amount ?? 0)} />
        <StatCard label="فروش بازار" value={toman(sales._sum.price ?? 0)} />
        <StatCard label="کمیسیون" value={toman(commissions._sum.commissionAmt ?? 0)} />
      </div>

      <CardTitle>معاملات</CardTitle>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="استراتژی فعال" value={faNumber(activeStrategies)} />
        <StatCard label="معاملات باز" value={faNumber(openTrades)} />
        <StatCard label="معاملات امروز" value={faNumber(dailyTrades)} />
        <StatCard label="خطای API (۲۴س)" value={faNumber(apiErrors)} tone={apiErrors > 0 ? "danger" : "default"} />
      </div>

      <Card>
        <CardTitle>وضعیت سرویس‌ها</CardTitle>
        <HealthChecks />
      </Card>
    </div>
  );
}
