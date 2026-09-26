import Link from "next/link";
import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { effectiveLimits, backtestUsage } from "@/modules/subscriptions/service";
import { Card, PageHeader, StatusBadge, Table, EmptyState, StatCard } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { faPercent, faNumber } from "@/shared/utils";

export default async function BacktestsPage() {
  const session = await currentSession();
  const [backtests, limits, used] = await Promise.all([
    prisma.backtest.findMany({
      where: { userId: session!.sub },
      orderBy: { createdAt: "desc" },
      include: { strategy: { select: { name: true } } },
    }),
    effectiveLimits(session!.sub),
    backtestUsage(session!.sub),
  ]);

  return (
    <div>
      <PageHeader title="بک‌تست‌ها" description="تاریخچه و نتایج شبیه‌سازی استراتژی‌ها" />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="سهمیه مصرف‌شده" value={limits.unlimited ? "نامحدود" : `${faNumber(used)} / ${faNumber(limits.backtestLimit)}`} />
        <StatCard label="بک‌تست موفق" value={faNumber(backtests.filter((b) => b.status === "COMPLETED").length)} />
        <StatCard label="در حال اجرا" value={faNumber(backtests.filter((b) => ["QUEUED", "RUNNING"].includes(b.status)).length)} />
      </div>
      {backtests.length === 0 ? (
        <EmptyState title="بک‌تستی اجرا نشده" hint="از صفحه استراتژی، بک‌تست جدید اجرا کنید" />
      ) : (
        <Card>
          <Table headers={["استراتژی", "نماد", "سود خالص", "نرخ برد", "معاملات", "وضعیت", "تاریخ", ""]}>
            {backtests.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-3 font-bold">{b.strategy.name}</td>
                <td className="px-4 py-3 ltr text-sm">{b.symbol} · {b.timeframe}</td>
                <td className="px-4 py-3 font-bold">
                  {b.profitPct !== null ? <span className={b.profitPct >= 0 ? "text-success" : "text-danger"}>{faPercent(b.profitPct)}</span> : "—"}
                </td>
                <td className="px-4 py-3">{b.winRate !== null ? faPercent(b.winRate) : "—"}</td>
                <td className="px-4 py-3">{b.totalTrades !== null ? faNumber(b.totalTrades) : "—"}</td>
                <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
                <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(b.createdAt)}</td>
                <td className="px-4 py-3"><Link href={`/backtests/${b.id}`} className="text-sm font-bold text-primary">جزئیات</Link></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
