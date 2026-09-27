import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, PageHeader, StatusBadge, Table, EmptyState, StatCard } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman, faNumber, faPercent } from "@/shared/utils";

export default async function TradesPage() {
  const session = await currentSession();
  const trades = await prisma.trade.findMany({
    where: { userId: session!.sub },
    orderBy: { openedAt: "desc" },
    take: 200,
    include: { liveStrategy: { include: { strategy: { select: { name: true } } } } },
  });

  const closed = trades.filter((t) => t.status === "CLOSED");
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;

  return (
    <div>
      <PageHeader title="تاریخچه معاملات" />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="کل معاملات" value={faNumber(trades.length)} />
        <StatCard label="باز" value={faNumber(trades.filter((t) => t.status === "OPEN").length)} />
        <StatCard label="سود/زیان" value={toman(totalPnl)} tone={totalPnl >= 0 ? "success" : "danger"} />
        <StatCard label="نرخ برد" value={faPercent(closed.length ? (wins / closed.length) * 100 : 0)} />
      </div>
      {trades.length === 0 ? (
        <EmptyState title="معامله‌ای ثبت نشده" />
      ) : (
        <Card>
          <Table headers={["استراتژی", "نماد", "جهت", "ورود", "خروج", "سود/زیان", "دلیل", "وضعیت", "زمان"]}>
            {trades.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-3 font-bold">
                  {t.liveStrategy?.strategy.name ?? "—"}
                  {t.liveStrategy?.mode === "PAPER" && <span className="mr-1 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-normal text-warning">تست</span>}
                </td>
                <td className="px-4 py-3 ltr">{t.symbol}</td>
                <td className="px-4 py-3">
                  {t.side === "SHORT"
                    ? <span className="rounded bg-danger/15 px-1.5 py-0.5 text-xs font-bold text-danger">شورت{t.leverage > 1 ? ` ${faNumber(t.leverage, true)}×` : ""}</span>
                    : <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs font-bold text-success">لانگ{t.leverage > 1 ? ` ${faNumber(t.leverage, true)}×` : ""}</span>}
                </td>
                <td className="px-4 py-3 ltr">{faNumber(t.entryPrice)}</td>
                <td className="px-4 py-3 ltr">{t.exitPrice ? faNumber(t.exitPrice) : "—"}</td>
                <td className="px-4 py-3 font-bold">
                  {t.pnl !== null ? <span className={t.pnl >= 0 ? "text-success" : "text-danger"}>{toman(t.pnl)} ({faPercent(t.pnlPct)})</span> : "—"}
                </td>
                <td className="px-4 py-3 text-xs">{t.exitReason ?? "—"}</td>
                <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(t.openedAt)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
