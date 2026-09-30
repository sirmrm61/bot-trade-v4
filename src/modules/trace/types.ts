/**
 * Trace & Debugging — structured observability for Backtest / Scanner / Strategy.
 *
 * Every run gets a `runId`; every evaluated candidate and every trade gets a
 * deterministic trace id so any decision can be replayed from stored inputs.
 * Events form a chain: SCANNER → STRATEGY → COST → RISK → ENTRY → POSITION →
 * EXIT → PNL_AUDIT, plus SYSTEM (look-ahead warnings, caps) and SUMMARY.
 */

export type TraceLevel = "OFF" | "SUMMARY" | "FULL";

export type TraceStage =
  | "SCANNER"      // market snapshot + market-data filters
  | "STRATEGY"     // indicator / signal evaluation
  | "COST"         // pre-entry cost & expected-profit estimate
  | "RISK"         // balance / sizing / exposure gates
  | "ENTRY"        // order execution (simulated or live)
  | "POSITION"     // per-tick position state, TP/SL checks
  | "EXIT"         // position close + realized cost breakdown
  | "PNL_AUDIT"    // independent recomputation of net PnL
  | "SUMMARY"      // run-level aggregates
  | "SYSTEM";      // look-ahead warnings, caps, internal errors

export type RejectionStage =
  | "MARKET_FILTER"
  | "LIQUIDITY"
  | "COST"
  | "STRATEGY"
  | "RISK"
  | "EXECUTION";

/** One recorded filter evaluation — scanner, cost gate, or strategy condition. */
export interface FilterCheck {
  filterName: string;
  result: "PASS" | "FAIL";
  actualValue: number | string | null;
  threshold: number | string | null;
  operator: string;
  reason: string;
}

/** Ambiguity policy when one candle touches both TP and SL.
 *  SL_FIRST / CONSERVATIVE resolve to the stop; TP_FIRST to the target;
 *  TICK_DATA_REQUIRED resolves conservatively but flags the candle as
 *  insufficiently granular. */
export type AmbiguityPolicy = "SL_FIRST" | "TP_FIRST" | "CONSERVATIVE" | "TICK_DATA_REQUIRED";

export interface TraceOptions {
  /** OFF = no events, SUMMARY = trades+counters only, FULL = every step */
  level: TraceLevel;
  /** scope filters — omit / undefined means "all" */
  symbols?: string[];
  /** only record events whose candleTs is inside [fromTs, toTs] */
  fromTs?: number;
  toTs?: number;
  /** replay / audit mode — record only this trade's chain */
  tradeTraceId?: string;
  /** event cap — protects against pathological FULL traces */
  maxEvents?: number;
  /** treat same-bar execution as an error instead of a warning */
  strictCausality?: boolean;
  /** how to resolve TP+SL touched by one candle */
  ambiguityPolicy?: AmbiguityPolicy;
}

export interface TraceEvent {
  /** monotonic sequence inside the run */
  seq: number;
  /** wall-clock ms when emitted (engine events use the candle time) */
  ts: number;
  runId: string;
  /** links events of one candidate / trade / opportunity */
  refId?: string;
  stage: TraceStage;
  event: string;
  symbol?: string;
  barIndex?: number;
  candleTs?: number;
  data?: Record<string, unknown>;
}

/** Aggregated run-level counters emitted as the SUMMARY event. */
export interface TraceSummary {
  totalEvaluations: number;
  candidates: number;
  signals: number;
  rejectedSignals: number;
  executedTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  grossProfit: number;
  grossLoss: number;
  totalFees: number;
  totalSlippageCost: number;
  totalSpreadCost: number;
  netProfit: number;
  tpCount: number;
  slCount: number;
  trailingCount: number;
  signalExitCount: number;
  otherExitCount: number;
  ambiguousExits: number;
  lookaheadWarnings: number;
  pnlAuditErrors: number;
  /** stage → count → % of rejections (e.g. COST → "Spread too high" → 41%) */
  rejectionsByStage: Record<string, number>;
  rejectionsByReason: Record<string, number>;
}
