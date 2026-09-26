import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { currentSubscription, effectiveLimits, backtestUsage, liveUsage } from "@/modules/subscriptions/service";
import { StatCard, Card, CardTitle, StatusBadge, PageHeader, EmptyState, Badge } from "@/components/ui";
import { jalaliDate, daysRemaining } from "@/shared/jalali";
import { toman, faPercent, faNumber } from "@/shared/utils";
import Link from "next/link";
import { EquityChart } from "@/components/charts";

type ClosedTrade = { pnl: number | null; closedAt: Date | null };

function cumulativeEquity(trades: ClosedTrade[]): { t: number; equity: number }[] {
  return trades
    .slice()
    .sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0))
    .reduce<{ t: number; equity: number }[]>((acc, t) => {
      acc.push({ t: t.closedAt?.getTime() ?? 0, equity: (acc.at(-1)?.equity ?? 0) + (t.pnl ?? 0) });
      return acc;
    }, []);
}

export default async function DashboardPage() {
  const session = await currentSession();
  const userId = session!.sub;

  const [sub, limits, btUsed, liveUsed, wallet, lives, trades, notifications] = await Promise.all([
    currentSubscription(userId),
    effectiveLimits(userId),
    backtestUsage(userId),
    liveUsage(userId),
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.liveStrategy.findMany({
      where: { userId, status: { in: ["RUNNING", "PAUSED", "STARTING", "DEGRADED"] } },
      include: { strategy: { select: { name: true } } },
    }),
    prisma.trade.findMany({ where: { userId }, orderBy: { openedAt: "desc" }, take: 10 }),
    prisma.notification.findMany({ where: { userId, read: false }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  const closedTrades = await prisma.trade.findMany({ where: { userId, status: "CLOSED", pnl: { not: null } } });
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;

  // cumulative equity curve from closed trades
  const equity = cumulativeEquity(closedTrades);

  return (
    <div>
      <PageHeader title="داشبورد" description="نمای کلی حساب و عملکرد شما" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="پلن فعلی"
          value={sub?.plan.name ?? "—"}
          hint={sub ? `انقضا: ${jalaliDate(sub.expiresAt)} (${faNumber(daysRemaining(sub.expiresAt))} روز)` : "بدون اشتراک"}
        />
        <StatCard label="سهمیه بک‌تست" value={limits.unlimited ? "نامحدود" : `${faNumber(btUsed)} / ${faNumber(limits.backtestLimit)}`} />
        <StatCard label="ظرفیت لایو" value={limits.unlimited ? "نامحدود" : `${faNumber(liveUsed)} / ${faNumber(limits.liveLimit)}`} />
        <StatCard label="موجودی کیف پول" value={toman(wallet?.balance ?? 0)} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard label="سود/زیان تجمعی" value={toman(totalPnl)} tone={totalPnl >= 0 ? "success" : "danger"} />
        <StatCard label="نرخ برد" value={faPercent(winRate)} />
        <StatCard label="معاملات باز" value={faNumber(trades.filter((t) => t.status === "OPEN").length)} />
      </div>

      {equity.length > 2 && (
        <Card className="mt-6">
          <CardTitle>منحنی سود تجمعی</CardTitle>
          <EquityChart data={equity} />
        </Card>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>استراتژی‌های فعال</CardTitle>
          {lives.length === 0 ? (
            <EmptyState title="استراتژی فعالی ندارید" hint="از بخش استراتژی‌ها یکی بسازید یا از بازار بخرید" />
          ) : (
            <ul className="space-y-3">
              {lives.map((l) => (
                <li key={l.id} className="flex items-center justify-between rounded-xl border border-border p-3">
                  <div>
                    <div className="font-bold">{l.strategy.name}</div>
                    <div className="text-xs text-muted ltr">{l.symbol}</div>
                  </div>
                  <StatusBadge status={l.status} />
                </li>
              ))}
            </ul>
          )}
          <Link href="/live" className="mt-4 inline-block text-sm font-bold text-primary">مشاهده همه ←</Link>
        </Card>

        <Card>
          <CardTitle>اعلان‌های خوانده‌نشده</CardTitle>
          {notifications.length === 0 ? (
            <p className="text-sm text-muted">اعلان جدیدی ندارید.</p>
          ) : (
            <ul className="space-y-3">
              {notifications.map((n) => (
                <li key={n.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm">{n.title}</span>
                    <Badge tone={n.severity === "ERROR" ? "danger" : n.severity === "SUCCESS" ? "success" : n.severity === "WARNING" ? "warning" : "info"}>
                      {n.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
          <Link href="/notifications" className="mt-4 inline-block text-sm font-bold text-primary">همه اعلان‌ها ←</Link>
        </Card>
      </div>
    </div>
  );
}
