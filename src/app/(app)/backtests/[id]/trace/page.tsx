import { notFound } from "next/navigation";
import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { PageHeader } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { parseJson } from "@/shared/utils";
import { backtestRunId } from "@/modules/trace/tracer";
import type { TraceEvent } from "@/modules/trace/types";
import { TraceViewer } from "./viewer";

export default async function BacktestTracePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  const { id } = await params;
  const bt = await prisma.backtest.findFirst({
    where: { id, userId: session!.sub },
    include: { strategy: { select: { name: true } }, trades: { orderBy: { entryTime: "asc" } } },
  });
  if (!bt) notFound();

  const runId = backtestRunId(bt.id);
  const raw = await prisma.traceEvent.findMany({
    where: { runId }, orderBy: { seq: "asc" }, take: 100_000,
  });
  const events: TraceEvent[] = raw.map((e) => ({
    seq: e.seq, ts: Number(e.ts), runId: e.runId, refId: e.refId ?? undefined,
    stage: e.stage as TraceEvent["stage"], event: e.event,
    symbol: e.symbol ?? undefined, barIndex: e.barIndex ?? undefined,
    candleTs: e.candleTs != null ? Number(e.candleTs) : undefined,
    data: e.data ? parseJson(e.data, undefined) : undefined,
  }));

  const results = parseJson<{ trace?: { summary?: unknown } }>(bt.results, {});
  const trades = bt.trades.map((t) => ({
    traceId: t.traceId, side: t.side, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
    pnl: t.pnl, pnlPct: t.pnlPct, exitReason: t.exitReason,
    entryTime: t.entryTime.getTime(), exitTime: t.exitTime?.getTime() ?? null,
    events: t.trace ? parseJson<TraceEvent[]>(t.trace, []) : [],
  }));

  return (
    <div>
      <PageHeader
        title={`ردیابی بک‌تست — ${bt.strategy.name}`}
        description={`${bt.symbol} · ${bt.timeframe} · ${jalaliDateTime(bt.startDate)} تا ${jalaliDateTime(bt.endDate)} · runId: ${runId}`}
      />
      <TraceViewer
        backtestId={bt.id}
        runId={runId}
        traceLevel={bt.traceLevel}
        events={events}
        trades={trades}
        storedSummary={results?.trace?.summary}
      />
    </div>
  );
}
