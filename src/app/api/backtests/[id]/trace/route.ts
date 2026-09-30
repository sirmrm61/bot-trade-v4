import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { traceRun, eventsToCsv } from "@/modules/trace/service";
import { backtestRunId } from "@/modules/trace/tracer";

/**
 * GET /api/backtests/:id/trace — the full structured event log of a traced run.
 * `?format=csv` exports the same events as CSV for offline analysis.
 */
export const GET = api(async (req, ctx) => {
  const id = ctx.params?.id;
  if (!id) throw new AppError("NOT_FOUND", 404);
  const bt = await prisma.backtest.findFirst({ where: { id, userId: ctx.userId } });
  if (!bt) throw new AppError("NOT_FOUND", 404);

  const runId = backtestRunId(bt.id);
  const events = await traceRun(ctx.userId, runId);
  const fmt = new URL(req.url).searchParams.get("format");
  if (fmt === "csv") {
    return new Response(eventsToCsv(events), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="trace-${bt.id}.csv"` },
    });
  }
  return {
    runId,
    traceLevel: bt.traceLevel,
    truncated: events.some((e) => e.event === "TRACE_TRUNCATED"),
    eventCount: events.length,
    events,
  };
});
