import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, StatusBadge, Table } from "@/components/ui";
import { STRATEGY_KIND_LABELS, type StrategyKind } from "@/shared/constants";
import { jalaliDateTime } from "@/shared/jalali";
import { faPercent, toman } from "@/shared/utils";
import { RunBacktestForm, GoLiveForm, PaperTestForm, SellForm, DeleteStrategyButton } from "./actions";
import { CandleChart, CandleChartLegend, type TradeMark } from "@/components/candle-chart";
import { loadBacktestChart } from "@/modules/backtest/chart-data";

function defaultBacktestRange() {
  const now = Date.now();
  return {
    from: new Date(now - 30 * 86_400_000).toISOString().slice(0, 10),
    to: new Date(now).toISOString().slice(0, 10),
  };
}

export default async function StrategyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  const { id } = await params;
  const strategy = await prisma.strategy.findFirst({
    where: { id, userId: session!.sub, status: { not: "DELETED" } },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, include: { indicators: true } },
      backtests: { orderBy: { createdAt: "desc" }, include: { trades: { orderBy: { entryTime: "asc" } } } },
      liveStrategies: { orderBy: { createdAt: "desc" } },
      listings: true,
    },
  });
  if (!strategy) notFound();
  const v = strategy.versions[0];

  // chart for the most recent completed backtest — with that version's indicators
  const latestDone = strategy.backtests.find((b) => b.status === "COMPLETED");
  const btVersion = strategy.versions.find((ver) => ver.id === latestDone?.versionId) ?? v;
  const chart = latestDone ? await loadBacktestChart(latestDone, btVersion?.indicators ?? [], {
    buyThreshold: btVersion?.buyThreshold,
    sellThreshold: btVersion?.sellThreshold,
    indicatorConfigs: btVersion?.indicators,
    kind: btVersion?.kind,
    config: btVersion?.config,
  }) : null;
  const chartTrades: TradeMark[] = (latestDone?.trades ?? []).map((t) => ({
    entryTime: t.entryTime.getTime(),
    exitTime: t.exitTime?.getTime() ?? null,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    exitReason: t.exitReason,
  }));

  return (
    <div>
      <PageHeader
        title={strategy.name}
        description={strategy.description ?? undefined}
        action={
          <div className="flex items-center gap-3">
            <StatusBadge status={strategy.status} />
            <DeleteStrategyButton strategyId={strategy.id} redirect="/strategies" />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardTitle>{["ORDER_BOOK_IMBALANCE", "MARKET_MAKING"].includes(v?.kind ?? "SIGNAL") ? "بک‌تست شبیه‌سازی‌شده" : "بک‌تست جدید"}</CardTitle>
          {["ORDER_BOOK_IMBALANCE", "MARKET_MAKING"].includes(v?.kind ?? "SIGNAL") && (
            <p className="mb-3 text-xs text-muted">
              دفتر سفارش تاریخی وجود ندارد — بک‌تست روی کندل‌ها شبیه‌سازی می‌شود
              {v?.kind === "ORDER_BOOK_IMBALANCE"
                ? " (پروکسی عدم‌توازن از موقعیت بسته‌شدن کندل در محدوده)"
                : " (فیل کوت‌ها با برخورد محدوده‌ی کندل)"}.
              برای ارزیابی واقعی‌تر، «تست زنده» را هم اجرا کنید.
            </p>
          )}
          <RunBacktestForm
            strategyId={strategy.id}
            versionId={v?.id}
            defaultFrom={defaultBacktestRange().from}
            defaultTo={defaultBacktestRange().to}
          />
        </Card>
        <Card>
          <CardTitle>اجرای زنده</CardTitle>
          <GoLiveForm strategyId={strategy.id} versionId={v?.id} hasBacktest={strategy.backtests.some((b) => b.status === "COMPLETED")} />
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-2 text-xs font-bold">تست زنده (Real-time)</p>
            <PaperTestForm strategyId={strategy.id} versionId={v?.id} />
          </div>
        </Card>
        <Card>
          <CardTitle>فروش در بازار</CardTitle>
          <SellForm strategyId={strategy.id} canSell={strategy.backtests.some((b) => b.status === "COMPLETED")} existing={strategy.listings.length > 0} />
        </Card>
      </div>

      <Card className="mt-6">
        <CardTitle>نسخه‌ها</CardTitle>
        <Table headers={["نسخه", "نوع", "نماد", "تایم‌فریم", "حد ضرر/سود", "اندیکاتورها", "ایجاد"]}>
          {strategy.versions.map((ver) => (
            <tr key={ver.id}>
              <td className="px-4 py-3 font-bold">v{ver.versionNumber}</td>
              <td className="px-4 py-3 text-xs">{STRATEGY_KIND_LABELS[(ver.kind ?? "SIGNAL") as StrategyKind]}</td>
              <td className="px-4 py-3 ltr">{ver.symbol}</td>
              <td className="px-4 py-3">{ver.timeframe}</td>
              <td className="px-4 py-3">{faPercent(ver.stopLossPct)} / {faPercent(ver.takeProfitPct)}</td>
              <td className="px-4 py-3 text-xs text-muted">
                {ver.indicators.filter((i) => i.enabled).map((i) => `${i.name}(${Math.round(i.weight * 100)}٪)`).join("، ")}
              </td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(ver.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardTitle>بک‌تست‌ها</CardTitle>
        {latestDone && chart && chart.candles.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-xs text-muted">
              نمودار آخرین بک‌تست — {latestDone.symbol} · {latestDone.timeframe} ·{" "}
              <Link href={`/backtests/${latestDone.id}`} className="font-bold text-primary">جزئیات کامل</Link>
            </p>
            <CandleChart candles={chart.candles} trades={chartTrades} overlays={chart.overlays} oscillators={chart.oscillators} signals={chart.signals} />
            <CandleChartLegend overlays={chart.overlays} oscillators={chart.oscillators} hasTrades={chartTrades.length > 0} hasSignals={chart.signals.length > 0} />
          </div>
        )}
        <Table headers={["نماد", "بازه", "سود", "نرخ برد", "وضعیت", "تاریخ", ""]}>
          {strategy.backtests.map((b) => (
            <tr key={b.id}>
              <td className="px-4 py-3 ltr">{b.symbol} · {b.timeframe}</td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(b.startDate)} تا {jalaliDateTime(b.endDate)}</td>
              <td className="px-4 py-3 font-bold">{b.profitPct !== null ? <span className={b.profitPct >= 0 ? "text-success" : "text-danger"}>{faPercent(b.profitPct)}</span> : "—"}</td>
              <td className="px-4 py-3">{b.winRate !== null ? faPercent(b.winRate) : "—"}</td>
              <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(b.createdAt)}</td>
              <td className="px-4 py-3"><Link href={`/backtests/${b.id}`} className="text-sm font-bold text-primary">جزئیات</Link></td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card className="mt-6">
        <CardTitle>اجراهای زنده</CardTitle>
        <Table headers={["نماد", "سرمایه", "وضعیت", "شروع", "معاملات"]}>
          {strategy.liveStrategies.map((l) => (
            <tr key={l.id}>
              <td className="px-4 py-3 ltr">{l.symbol}</td>
              <td className="px-4 py-3">{toman(l.allocatedCapital)}</td>
              <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(l.startedAt)}</td>
              <td className="px-4 py-3"><Link href="/live" className="text-sm font-bold text-primary">مشاهده</Link></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
