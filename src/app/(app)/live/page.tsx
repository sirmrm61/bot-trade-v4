import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, PageHeader, StatusBadge, EmptyState, StatCard, Badge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman, faNumber, parseJson } from "@/shared/utils";
import { PauseButton, StopButtons } from "./actions";
import { LiveChart } from "@/components/live-chart";

export default async function LivePage() {
  const session = await currentSession();
  const lives = await prisma.liveStrategy.findMany({
    where: { userId: session!.sub },
    orderBy: { createdAt: "desc" },
    include: {
      strategy: { select: { name: true } },
      version: { select: { versionNumber: true, timeframe: true } },
      trades: { orderBy: { openedAt: "desc" } },
      orders: { where: { status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] } } },
    },
  });

  const running = lives.filter((l) => ["RUNNING", "STARTING", "PAUSED", "DEGRADED"].includes(l.status));

  return (
    <div>
      <PageHeader title="معاملات زنده" description="استراتژی‌های در حال اجرا و معاملات باز" />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="فعال" value={faNumber(running.length)} />
        <StatCard label="معاملات باز" value={faNumber(lives.flatMap((l) => l.trades).filter((t) => t.status === "OPEN").length)} />
        <StatCard label="سفارش‌های باز" value={faNumber(lives.flatMap((l) => l.orders).length)} />
        <StatCard label="کاهش‌یافته" value={faNumber(lives.filter((l) => l.status === "DEGRADED").length)} tone="warning" />
      </div>

      {lives.length === 0 ? (
        <EmptyState title="استراتژی زنده‌ای ندارید" hint="از صفحه استراتژی، بعد از بک‌تست موفق اجرای زنده را شروع کنید" />
      ) : (
        <div className="space-y-5">
          {lives.map((l) => {
            const stats = parseJson<{ lastSignal?: string; lastScore?: number; kind?: string; mid?: number; openQuotes?: number; inventoryPct?: number; pnl?: number; fills?: number }>(l.stats, {});
            const openTrades = l.trades.filter((t) => t.status === "OPEN");
            const closedTrades = l.trades.filter((t) => t.status === "CLOSED");
            const pnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
            return (
              <Card key={l.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-black">{l.strategy.name}</span>
                      <StatusBadge status={l.status} />
                      {l.mode === "PAPER" && <Badge tone="warning">تست</Badge>}
                      <span className="text-xs text-muted ltr">{l.symbol} · {l.version.timeframe} · v{l.version.versionNumber}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted">
                      <span>سرمایه: <b className="text-foreground">{toman(l.allocatedCapital)}</b></span>
                      <span>سود/زیان: <b className={pnl >= 0 ? "text-success" : "text-danger"}>{toman(pnl)}</b></span>
                      {stats.kind === "MARKET_MAKING" ? (
                        <span>
                          میانی: <b className="ltr">{faNumber(stats.mid ?? 0, true)}</b> · کوت‌های باز: {faNumber(stats.openQuotes ?? 0)} · موجودی: {faNumber(stats.inventoryPct ?? 0, true)}٪
                          {l.mode === "PAPER" && ` · فیل‌ها: ${faNumber(stats.fills ?? 0)} · PnL تست: ${faNumber(stats.pnl ?? 0, true)}`}
                        </span>
                      ) : (
                        <span>آخرین سیگنال: {stats.lastSignal ?? "—"} ({stats.lastScore?.toFixed(2) ?? "—"})</span>
                      )}
                      <span>شروع: {jalaliDateTime(l.startedAt)}</span>
                    </div>
                  </div>
                  {["RUNNING", "STARTING", "DEGRADED"].includes(l.status) && (
                    <div className="flex gap-2">
                      <PauseButton id={l.id} />
                      <StopButtons id={l.id} />
                    </div>
                  )}
                  {l.status === "PAUSED" && (
                    <div className="flex items-center gap-2">
                      <Badge tone="warning">معامله جدید ایجاد نمی‌شود — معاملات باز مدیریت می‌شوند</Badge>
                      <StopButtons id={l.id} />
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <LiveChart liveId={l.id} active={["RUNNING", "STARTING", "PAUSED", "DEGRADED"].includes(l.status)} />
                </div>

                {openTrades.length > 0 && (
                  <div className="mt-4 rounded-xl border border-border">
                    <div className="border-b border-border px-4 py-2 text-sm font-bold">معاملات باز</div>
                    {openTrades.map((t) => (
                      <div key={t.id} className="flex flex-wrap items-center gap-4 px-4 py-2 text-sm">
                        <span className="ltr">{t.symbol}</span>
                        <span>ورود: <b className="ltr">{faNumber(t.entryPrice)}</b></span>
                        <span>حجم: <b className="ltr">{faNumber(t.amount, true)}</b></span>
                        <span className="text-xs text-muted">SL: {faNumber(t.stopLossPrice)} · TP: {faNumber(t.takeProfitPrice)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
