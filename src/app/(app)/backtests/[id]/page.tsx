import { notFound } from "next/navigation";
import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, StatusBadge, Table } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { faPercent, faNumber, toman, parseJson } from "@/shared/utils";
import { EquityChart } from "@/components/charts";
import { CandleChart, CandleChartLegend, type TradeMark } from "@/components/candle-chart";
import { loadBacktestChart } from "@/modules/backtest/chart-data";

export default async function BacktestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  const { id } = await params;
  const bt = await prisma.backtest.findFirst({
    where: { id, userId: session!.sub },
    include: {
      strategy: { select: { name: true } },
      trades: { orderBy: { entryTime: "asc" } },
      version: { include: { indicators: true } },
    },
  });
  if (!bt) notFound();

  // candles + the version's indicators for the tested range
  const chart = bt.status === "COMPLETED"
    ? await loadBacktestChart(bt, bt.version?.indicators ?? [], {
      buyThreshold: bt.version?.buyThreshold,
      sellThreshold: bt.version?.sellThreshold,
      indicatorConfigs: bt.version?.indicators,
      kind: bt.version?.kind,
      config: bt.version?.config,
    })
    : { candles: [], overlays: [], oscillators: [], signals: [] };
  const chartTrades: TradeMark[] = bt.trades.map((t) => ({
    entryTime: t.entryTime.getTime(),
    exitTime: t.exitTime?.getTime() ?? null,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    exitReason: t.exitReason,
  }));

  const equity = parseJson<{ t: number; equity: number }[]>(bt.equityCurve, []);
  const stats: [string, string][] = [
    ["موجودی اولیه", toman(bt.initialBalance)],
    ["موجودی نهایی", bt.finalBalance !== null ? toman(bt.finalBalance) : "—"],
    ["سود خالص", bt.netProfit !== null ? toman(bt.netProfit) : "—"],
    ["درصد سود", faPercent(bt.profitPct)],
    ["نرخ برد", faPercent(bt.winRate)],
    ["نرخ باخت", faPercent(bt.lossRate)],
    ["کل معاملات", faNumber(bt.totalTrades)],
    ["میانگین سود", bt.avgProfit !== null ? toman(bt.avgProfit) : "—"],
    ["میانگین زیان", bt.avgLoss !== null ? toman(bt.avgLoss) : "—"],
    ["حداکثر افت", faPercent(bt.maxDrawdown)],
    ["ضریب سود", bt.profitFactor !== null ? faNumber(bt.profitFactor, true) : "—"],
    ["بزرگترین برد", bt.largestWin !== null ? toman(bt.largestWin) : "—"],
    ["بزرگترین باخت", bt.largestLoss !== null ? toman(bt.largestLoss) : "—"],
    ["میانگین مدت معامله", bt.avgTradeDurationMin !== null ? `${faNumber(bt.avgTradeDurationMin)} دقیقه` : "—"],
  ];

  return (
    <div>
      <PageHeader
        title={`بک‌تست ${bt.strategy.name}`}
        description={`${bt.symbol} · ${bt.timeframe} · ${jalaliDateTime(bt.startDate)} تا ${jalaliDateTime(bt.endDate)}`}
        action={<StatusBadge status={bt.status} />}
      />
      {bt.status !== "COMPLETED" ? (
        <Card>
          <p className="text-muted">{bt.status === "FAILED" ? `خطا: ${bt.error ?? "نامشخص"}` : "در حال اجرا — صفحه را تازه کنید."}</p>
        </Card>
      ) : (
        <>
          {chart.candles.length > 0 && (
            <Card className="mb-6">
              <CardTitle>نمودار قیمت، اندیکاتورها و معاملات — {bt.symbol}</CardTitle>
              <CandleChart candles={chart.candles} trades={chartTrades} overlays={chart.overlays} oscillators={chart.oscillators} signals={chart.signals} />
              <CandleChartLegend overlays={chart.overlays} oscillators={chart.oscillators} hasTrades={chartTrades.length > 0} hasSignals={chart.signals.length > 0} />
            </Card>
          )}
          {equity.length > 2 && (
            <Card className="mb-6">
              <CardTitle>منحنی موجودی (Equity Curve)</CardTitle>
              <EquityChart data={equity} />
            </Card>
          )}
          <Card>
            <CardTitle>شاخص‌های عملکرد</CardTitle>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 lg:grid-cols-4">
              {stats.map(([k, v]) => (
                <div key={k} className="rounded-xl border border-border p-3">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="mt-1 font-bold">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card className="mt-6">
            <CardTitle>معاملات ({faNumber(bt.trades.length)})</CardTitle>
            <Table headers={["ورود", "خروج", "قیمت ورود", "قیمت خروج", "سود/زیان", "دلیل خروج"]}>
              {bt.trades.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(t.entryTime)}</td>
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(t.exitTime)}</td>
                  <td className="px-4 py-3 ltr">{faNumber(t.entryPrice)}</td>
                  <td className="px-4 py-3 ltr">{t.exitPrice ? faNumber(t.exitPrice) : "—"}</td>
                  <td className="px-4 py-3 font-bold">
                    {t.pnl !== null ? <span className={t.pnl >= 0 ? "text-success" : "text-danger"}>{toman(t.pnl)}</span> : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs">{t.exitReason ?? "—"}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
