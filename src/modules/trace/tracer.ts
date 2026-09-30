import type {
  TraceEvent,
  TraceOptions,
  TraceStage,
  TraceSummary,
  FilterCheck,
} from "./types";

const DEFAULT_MAX_EVENTS = 50_000;

/** deterministic ids — same inputs → same ids, so a run replays identically */
export const makeScanRunId = () => `scan-${Date.now().toString(36)}`;
export const backtestRunId = (backtestId: string) => `bt-${backtestId}`;
export const opportunityTraceId = (runId: string, symbol: string, ts: number) =>
  `opp-${runId}-${symbol}-${ts}`;
export const tradeTraceId = (runId: string, seq: number) => `tr-${runId}-${seq}`;

/**
 * In-memory event collector. Zero-cost when level=OFF — `emit` returns before
 * touching anything so instrumentation stays free in production runs.
 *
 * Scope filters narrow what gets stored: symbol, candle-time range, or a
 * single tradeTraceId for replay audits.
 */
export class Tracer {
  readonly runId: string;
  readonly opts: TraceOptions;
  private seq = 0;
  private stored = 0;
  readonly events: TraceEvent[] = [];
  truncated = false;

  /** run-level counters aggregated into the final SUMMARY event */
  counters = {
    totalEvaluations: 0,
    candidates: 0,
    signals: 0,
    rejectedSignals: 0,
    executedTrades: 0,
    closedTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    grossProfit: 0,
    grossLoss: 0,
    totalFees: 0,
    totalSlippageCost: 0,
    totalSpreadCost: 0,
    netProfit: 0,
    tpCount: 0,
    slCount: 0,
    trailingCount: 0,
    signalExitCount: 0,
    otherExitCount: 0,
    ambiguousExits: 0,
    lookaheadWarnings: 0,
    pnlAuditErrors: 0,
    rejectionsByStage: {} as Record<string, number>,
    rejectionsByReason: {} as Record<string, number>,
  };

  constructor(runId: string, opts: Partial<TraceOptions> = {}) {
    this.runId = runId;
    this.opts = { level: "OFF", ...opts };
  }

  get enabled() {
    return this.opts.level !== "OFF";
  }
  get full() {
    return this.opts.level === "FULL";
  }

  private inScope(scope: { symbol?: string; candleTs?: number; refId?: string }) {
    const o = this.opts;
    if (o.symbols?.length && scope.symbol && !o.symbols.includes(scope.symbol)) return false;
    if (scope.candleTs !== undefined) {
      if (o.fromTs !== undefined && scope.candleTs < o.fromTs) return false;
      if (o.toTs !== undefined && scope.candleTs > o.toTs) return false;
    }
    if (o.tradeTraceId && scope.refId && scope.refId !== o.tradeTraceId) return false;
    return true;
  }

  emit(e: {
    stage: TraceStage;
    event: string;
    refId?: string;
    symbol?: string;
    barIndex?: number;
    candleTs?: number;
    ts?: number;
    data?: Record<string, unknown>;
    /** SUMMARY-level events are stored even when level=SUMMARY */
    important?: boolean;
  }): void {
    if (!this.enabled) return;
    if (this.opts.level === "SUMMARY" && !e.important) return;
    if (!this.inScope(e)) return;
    const max = this.opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (this.stored >= max) {
      if (!this.truncated) {
        this.truncated = true;
        this.events.push({
          seq: this.seq++, ts: Date.now(), runId: this.runId, stage: "SYSTEM",
          event: "TRACE_TRUNCATED", data: { maxEvents: max },
        });
      }
      return;
    }
    this.stored++;
    this.events.push({
      seq: this.seq++,
      ts: e.ts ?? e.candleTs ?? Date.now(),
      runId: this.runId,
      refId: e.refId,
      stage: e.stage,
      event: e.event,
      symbol: e.symbol,
      barIndex: e.barIndex,
      candleTs: e.candleTs,
      data: e.data,
    });
  }

  /** record one filter evaluation + update rejection counters on FAIL */
  filter(refId: string | undefined, f: FilterCheck, scope?: { symbol?: string; candleTs?: number; barIndex?: number }) {
    this.emit({
      stage: "SCANNER", event: "FILTER_RESULT", refId,
      symbol: scope?.symbol, candleTs: scope?.candleTs, barIndex: scope?.barIndex,
      data: { ...f },
    });
  }

  /** record a rejection — bumps stage/reason counters for the summary */
  reject(stage: keyof Tracer["counters"]["rejectionsByStage"] extends never ? string : string, reason: string) {
    this.counters.rejectionsByStage[stage] = (this.counters.rejectionsByStage[stage] ?? 0) + 1;
    this.counters.rejectionsByReason[reason] = (this.counters.rejectionsByReason[reason] ?? 0) + 1;
  }

  /** final SUMMARY event — always emitted when tracing is on */
  summary(): TraceSummary {
    const s: TraceSummary = { ...this.counters };
    if (this.enabled) {
      this.events.push({
        seq: this.seq++, ts: Date.now(), runId: this.runId,
        stage: "SUMMARY", event: "RUN_SUMMARY",
        data: s as unknown as Record<string, unknown>,
      });
    }
    return s;
  }
}
