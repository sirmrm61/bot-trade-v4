"use client";
import { useState } from "react";
import { Card, CardTitle, Badge } from "@/components/ui";
import { faNumber, faPercent } from "@/shared/utils";
import { jalaliDateTime } from "@/shared/jalali";
import type { TraceEvent, TraceSummary } from "@/modules/trace/types";

/* ---------------------------------------------------------------
   Trace Viewer — run summary → rejection diagnosis → per-trade
   timeline (market → scanner → strategy → cost → entry → position
   → exit → pnl audit) + deterministic replay.
------------------------------------------------------------------ */

const STAGE_FA: Record<string, string> = {
  SCANNER: "اسکنر", STRATEGY: "استراتژی", COST: "هزینه", RISK: "ریسک",
  ENTRY: "ورود", POSITION: "پوزیشن", EXIT: "خروج", PNL_AUDIT: "حسابرسی",
  SUMMARY: "خلاصه", SYSTEM: "سیستم",
};
const STAGE_COLOR: Record<string, string> = {
  SCANNER: "text-info", STRATEGY: "text-accent", COST: "text-warning", RISK: "text-warning",
  ENTRY: "text-success", POSITION: "text-muted", EXIT: "text-success", PNL_AUDIT: "text-accent",
  SUMMARY: "text-foreground", SYSTEM: "text-danger",
};

interface TradeRow {
  traceId: string | null; side: string; entryPrice: number; exitPrice: number | null;
  pnl: number | null; pnlPct: number | null; exitReason: string | null;
  entryTime: number; exitTime: number | null; events: TraceEvent[];
}

function fmtTs(e: TraceEvent) {
  const ms = e.candleTs ?? e.ts;
  return ms ? jalaliDateTime(new Date(ms)) : "—";
}

/** human-readable key fields per event — the timeline row content */
function EventDetail({ e }: { e: TraceEvent }) {
  const d = e.data ?? {};
  const rows: [string, unknown][] = Object.entries(d).filter(([, v]) => v !== undefined && v !== null);
  if (rows.length === 0) return null;
  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] md:grid-cols-3">
      {rows.slice(0, 30).map(([k, v]) => (
        <div key={k} className="flex gap-1 overflow-hidden">
          <dt className="text-muted shrink-0">{k}:</dt>
          <dd className="ltr truncate" title={typeof v === "object" ? JSON.stringify(v) : String(v)}>
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Timeline({ events }: { events: TraceEvent[] }) {
  return (
    <ol className="relative border-s-2 border-border ps-4 space-y-3 py-1">
      {events.map((e) => (
        <li key={e.seq} className="relative">
          <span className={`absolute -start-[21px] top-1.5 size-2 rounded-full ${e.event.includes("MISMATCH") || e.event.includes("LOOKAHEAD") || e.event.includes("AMBIGUOUS") || e.event.includes("REJECTED") ? "bg-danger" : "bg-accent"}`} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="text-muted ltr">{fmtTs(e)}</span>
            <span className={`font-bold ${STAGE_COLOR[e.stage] ?? ""}`}>{STAGE_FA[e.stage] ?? e.stage}</span>
            <Badge tone={e.event.includes("REJECTED") || e.event.includes("MISMATCH") ? "danger" : e.event.includes("LOOKAHEAD") || e.event.includes("AMBIGUOUS") ? "warning" : "default"}>
              {e.event}
            </Badge>
          </div>
          <EventDetail e={e} />
        </li>
      ))}
    </ol>
  );
}

function TradeCard({ trade }: { trade: TradeRow }) {
  const [open, setOpen] = useState(false);
  const [replay, setReplay] = useState<null | { match: boolean; reason: string; diffs?: string[] }>(null);
  const [loading, setLoading] = useState(false);

  const doReplay = async () => {
    if (!trade.traceId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/trace/${trade.traceId}/replay`, { method: "POST" });
      setReplay(await r.json());
    } catch {
      setReplay({ match: false, reason: "REPLAY_FAILED" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-border">
      <button onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-start hover:bg-surface2/50">
        <span className={`font-bold ${trade.pnl != null && trade.pnl >= 0 ? "text-success" : "text-danger"}`}>
          {trade.pnlPct != null ? faPercent(trade.pnlPct) : "—"}
        </span>
        <span className="text-xs text-muted ltr">{jalaliDateTime(new Date(trade.entryTime))}</span>
        <span className="text-xs ltr">{faNumber(trade.entryPrice)} → {trade.exitPrice ? faNumber(trade.exitPrice) : "—"}</span>
        <Badge tone="default">{trade.exitReason ?? "—"}</Badge>
        {trade.traceId && <code className="text-[10px] text-muted ltr">{trade.traceId}</code>}
        <span className="ms-auto text-xs text-muted">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">
          {trade.traceId && (
            <div className="mb-3 flex items-center gap-2">
              <button
                onClick={doReplay} disabled={loading}
                className="rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-bold text-accent hover:bg-accent/25 disabled:opacity-50"
              >
                {loading ? "در حال بازپخش…" : "بازپخش معامله (Replay)"}
              </button>
              {replay && (
                <Badge tone={replay.match ? "success" : "danger"}>{replay.reason}</Badge>
              )}
              {replay?.diffs?.map((d) => <span key={d} className="text-[10px] text-danger ltr">{d}</span>)}
            </div>
          )}
          {trade.events.length > 0 ? (
            <Timeline events={trade.events} />
          ) : (
            <p className="text-xs text-muted">برای این معامله رویداد trace ذخیره نشده — بک‌تست با traceLevel=SUMMARY یا FULL اجرا کنید.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function TraceViewer({ backtestId, runId, traceLevel, events, trades, storedSummary }: {
  backtestId: string; runId: string; traceLevel: string;
  events: TraceEvent[]; trades: TradeRow[]; storedSummary: unknown;
}) {
  const summary = (storedSummary ?? null) as TraceSummary | null;
  const [showAllEvents, setShowAllEvents] = useState(false);

  // derive summary from events if the run predates stored summaries
  const rejections = Object.entries(summary?.rejectionsByReason ?? {}).sort((a, b) => b[1] - a[1]);
  const totalRejects = rejections.reduce((s, [, n]) => s + n, 0);
  const warnings = events.filter((e) =>
    ["LOOKAHEAD_BIAS", "AMBIGUOUS_EXIT", "PNL_MISMATCH", "TRACE_TRUNCATED", "LOOKAHEAD_ENFORCED"].includes(e.event),
  );
  const nonTradeEvents = events.filter((e) => !trades.some((t) => t.traceId === e.refId) && e.stage !== "SUMMARY");

  const stats: [string, string][] = summary ? [
    ["ارزیابی‌ها", faNumber(summary.totalEvaluations)],
    ["کاندیدها", faNumber(summary.candidates)],
    ["سیگنال‌ها", faNumber(summary.signals)],
    ["معاملات", faNumber(summary.closedTrades)],
    ["برد / باخت", `${faNumber(summary.winningTrades)} / ${faNumber(summary.losingTrades)}`,
    ],
    ["سود ناخالص", faNumber(summary.grossProfit, true)],
    ["زیان ناخالص", faNumber(summary.grossLoss, true)],
    ["کارمزد کل", faNumber(summary.totalFees, true)],
    ["هزینه لغزش", faNumber(summary.totalSlippageCost, true)],
    ["سود خالص", faNumber(summary.netProfit, true)],
    ["TP / SL", `${faNumber(summary.tpCount)} / ${faNumber(summary.slCount)}`],
    ["خروج مبهم", faNumber(summary.ambiguousExits)],
    ["هشدار lookahead", faNumber(summary.lookaheadWarnings)],
    ["خطای audit", faNumber(summary.pnlAuditErrors)],
  ] : [];

  return (
    <div className="space-y-6">
      {traceLevel === "OFF" ? (
        <Card>
          <p className="text-muted">
            این بک‌تست با <code className="ltr">traceLevel=OFF</code> اجرا شده — رویدادی ذخیره نشده.
            برای ردیابی، هنگام اجرای بک‌تست <code className="ltr">traceLevel=SUMMARY</code> یا{" "}
            <code className="ltr">FULL</code> بفرستید.
          </p>
        </Card>
      ) : (
        <>
          {stats.length > 0 && (
            <Card>
              <CardTitle>خلاصه اجرا — {runId}</CardTitle>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4 lg:grid-cols-7">
                {stats.map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-border p-3">
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className="mt-1 font-bold ltr">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          {rejections.length > 0 && (
            <Card>
              <CardTitle>چرا بک‌تست جواب نمی‌دهد؟ — دلایل رد</CardTitle>
              <div className="space-y-2">
                {rejections.map(([reason, n]) => (
                  <div key={reason} className="flex items-center gap-3">
                    <div className="h-2 rounded bg-danger/70" style={{ width: `${Math.max(4, (n / totalRejects) * 200)}px` }} />
                    <span className="w-14 text-xs font-bold ltr">{faPercent((n / totalRejects) * 100)}</span>
                    <span className="text-xs">{reason}</span>
                    <span className="text-xs text-muted ltr">×{faNumber(n)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {warnings.length > 0 && (
            <Card>
              <CardTitle>هشدارها ({faNumber(warnings.length)})</CardTitle>
              <ul className="space-y-1 text-xs">
                {warnings.slice(0, 50).map((e) => (
                  <li key={e.seq} className="flex flex-wrap items-center gap-2">
                    <Badge tone={e.event === "LOOKAHEAD_ENFORCED" ? "warning" : "danger"}>{e.event}</Badge>
                    <span className="text-muted ltr">{fmtTs(e)}</span>
                    <span className="text-muted">{String(e.data?.detail ?? e.data?.policy ?? "")}</span>
                  </li>
                ))}
                {warnings.length > 50 && <li className="text-muted">…و {faNumber(warnings.length - 50)} مورد دیگر</li>}
              </ul>
            </Card>
          )}

          <Card>
            <CardTitle>معاملات — زنجیره تصمیم هر معامله ({faNumber(trades.length)})</CardTitle>
            {trades.length === 0 ? (
              <p className="text-sm text-muted">هیچ معامله‌ای اجرا نشد — جدول «دلایل رد» بالا علت را نشان می‌دهد.</p>
            ) : (
              <div className="space-y-2">
                {trades.map((t, i) => <TradeCard key={t.traceId ?? i} trade={t} />)}
              </div>
            )}
          </Card>

          {nonTradeEvents.length > 0 && (
            <Card>
              <div className="flex items-center justify-between">
                <CardTitle>رویدادهای دیگر ({faNumber(nonTradeEvents.length)})</CardTitle>
                <div className="flex gap-2">
                  <a href={`/api/backtests/${backtestId}/trace?format=csv`} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface2">
                    دانلود CSV
                  </a>
                  <button onClick={() => setShowAllEvents(!showAllEvents)} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface2">
                    {showAllEvents ? "بستن" : "نمایش"}
                  </button>
                </div>
              </div>
              {showAllEvents && <Timeline events={nonTradeEvents.slice(0, 1000)} />}
              {showAllEvents && nonTradeEvents.length > 1000 && (
                <p className="mt-2 text-xs text-muted">۱۰۰۰ رویداد اول نمایش داده شد — CSV برای لیست کامل.</p>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
