import { prisma } from "@/infrastructure/database/prisma";
import { Card, CardTitle, PageHeader, Table, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { faPercent, toman } from "@/shared/utils";

export default async function AdminOverviewPage() {
  const [strategies, backtests, lives, trades, referrals] = await Promise.all([
    prisma.strategy.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { user: { select: { username: true } }, versions: { take: 1, orderBy: { versionNumber: "desc" } } } }),
    prisma.backtest.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { user: { select: { username: true } }, strategy: { select: { name: true } } } }),
    prisma.liveStrategy.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { user: { select: { username: true } }, strategy: { select: { name: true } } } }),
    prisma.trade.findMany({ orderBy: { openedAt: "desc" }, take: 50, include: { user: { select: { username: true } } } }),
    prisma.referral.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { referrer: { select: { username: true } }, referee: { select: { username: true } } } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="نمای کلی سیستم" />

      <Card>
        <CardTitle>استراتژی‌ها</CardTitle>
        <Table headers={["کاربر", "نام", "نماد", "وضعیت", "ایجاد"]}>
          {strategies.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-3">{s.user.username}</td>
              <td className="px-4 py-3 font-bold">{s.name}</td>
              <td className="px-4 py-3 ltr">{s.versions[0]?.symbol ?? "—"}</td>
              <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(s.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardTitle>بک‌تست‌ها</CardTitle>
        <Table headers={["کاربر", "استراتژی", "نماد", "سود", "وضعیت", "تاریخ"]}>
          {backtests.map((b) => (
            <tr key={b.id}>
              <td className="px-4 py-3">{b.user.username}</td>
              <td className="px-4 py-3 font-bold">{b.strategy.name}</td>
              <td className="px-4 py-3 ltr">{b.symbol}</td>
              <td className="px-4 py-3">{b.profitPct !== null ? faPercent(b.profitPct) : "—"}</td>
              <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(b.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardTitle>استراتژی‌های زنده</CardTitle>
        <Table headers={["کاربر", "استراتژی", "نماد", "سرمایه", "وضعیت", "شروع"]}>
          {lives.map((l) => (
            <tr key={l.id}>
              <td className="px-4 py-3">{l.user.username}</td>
              <td className="px-4 py-3 font-bold">{l.strategy.name}</td>
              <td className="px-4 py-3 ltr">{l.symbol}</td>
              <td className="px-4 py-3">{toman(l.allocatedCapital)}</td>
              <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(l.startedAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardTitle>معاملات اخیر</CardTitle>
        <Table headers={["کاربر", "نماد", "ورود", "سود/زیان", "وضعیت"]}>
          {trades.map((t) => (
            <tr key={t.id}>
              <td className="px-4 py-3">{t.user.username}</td>
              <td className="px-4 py-3 ltr">{t.symbol}</td>
              <td className="px-4 py-3 ltr">{t.entryPrice}</td>
              <td className="px-4 py-3">{t.pnl !== null ? toman(t.pnl) : "—"}</td>
              <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardTitle>رفرال‌ها</CardTitle>
        <Table headers={["معرف", "دعوت‌شده", "API", "معامله", "پاداش"]}>
          {referrals.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-3">{r.referrer.username}</td>
              <td className="px-4 py-3">{r.referee.username}</td>
              <td className="px-4 py-3">{r.apiConnected ? "✓" : "—"}</td>
              <td className="px-4 py-3">{r.firstLiveTrade ? "✓" : "—"}</td>
              <td className="px-4 py-3">{r.completed ? `+${r.bonusDays} روز` : "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
