import type { Candle } from "@/modules/exchanges/types";
import { atr, ema } from "@/modules/indicators/engine";
import { clamp } from "@/shared/utils";

/**
 * Market Opportunity Engine — pure functions, no DB/IO.
 *
 * Same logic runs live (on the freshest candles) and inside the scanner
 * backtest (walk-forward over historical candles) — the spec requires the
 * scanner, strategy and risk logic to behave identically in both paths.
 *
 * Direction comes from momentum (EMA cross + short-window return), TP/SL are
 * dynamic — sized from ATR and the measured round-trip cost, never a fixed %.
 */

export interface OpportunityConfig {
  atrPeriod: number;        // ATR window for dynamic stops
  atrSlMult: number;        // SL distance = atrPct × this
  atrTpMult: number;        // TP distance = atrPct × this
  minNetReturnPct: number;  // net expected return below → skip
  minRiskReward: number;    // tp/sl ratio below → skip
  minMomentumPct: number;   // |6-candle return| below → no directional edge
  horizonCandles: number;   // candles an opportunity stays valid for
}

export const OPPORTUNITY_DEFAULTS: OpportunityConfig = {
  atrPeriod: 14,
  atrSlMult: 1.5,
  atrTpMult: 2.5,
  minNetReturnPct: 0.15,
  minRiskReward: 1.2,
  minMomentumPct: 0.05,
  horizonCandles: 20,
};

export interface OpportunityCalc {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  grossReturnPct: number;   // tp distance
  totalCostPct: number;     // round-trip trading cost
  netReturnPct: number;     // gross - cost
  riskReward: number;
  score: number;            // confidence 0..100
  reasons: string[];
}

/** Momentum direction: EMA(9) vs EMA(21) cross + last-6-candle return. */
export function detectDirection(
  candles: Candle[],
  minMomentumPct = OPPORTUNITY_DEFAULTS.minMomentumPct,
): { direction: "LONG" | "SHORT"; momentumPct: number } | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const i = closes.length - 1;
  if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i])) return null;
  const momentumPct = ((closes[i] - closes[i - 6]) / closes[i - 6]) * 100;
  const emaDiff = fast[i] - slow[i];
  // both must agree — EMA tilt alone is too noisy for entry direction
  if (emaDiff > 0 && momentumPct > minMomentumPct) return { direction: "LONG", momentumPct };
  if (emaDiff < 0 && momentumPct < -minMomentumPct) return { direction: "SHORT", momentumPct };
  return null;
}

/** ATR-based dynamic stops — the market dictates TP/SL, not a constant. */
export function dynamicStops(
  candles: Candle[],
  costPct: number,
  cfg: OpportunityConfig = OPPORTUNITY_DEFAULTS,
): { slPct: number; tpPct: number; atrPct: number } | null {
  const a = atr(candles, cfg.atrPeriod);
  const atrVal = a[a.length - 1];
  const last = candles[candles.length - 1]?.close;
  if (!Number.isFinite(atrVal) || !last) return null;
  const atrPct = (atrVal / last) * 100;
  // SL must outrun noise AND round-trip cost; TP gets a modest cost floor —
  // if cost still dominates the edge, computeOpportunity rejects (never inflate
  // TP into fantasy territory just to make the math look positive)
  const slPct = clamp(Math.max(cfg.atrSlMult * atrPct, 1.2 * costPct), 0.2, 8);
  const tpPct = clamp(Math.max(cfg.atrTpMult * atrPct, 1.5 * costPct, cfg.minRiskReward * slPct), 0.3, 12);
  return { slPct, tpPct, atrPct };
}

export interface OpportunityRejection {
  stage: "MARKET_FILTER" | "LIQUIDITY" | "COST" | "STRATEGY" | "RISK" | "EXECUTION";
  primaryRejectReason: string;
  filters: { filterName: string; result: "PASS" | "FAIL"; actualValue: number | null; threshold: number | null; operator: string; reason: string }[];
}

export interface OpportunityVerdict {
  opportunity: OpportunityCalc | null;
  rejection: OpportunityRejection | null;
}

/**
 * Traced evaluation — same math as computeOpportunity, but instead of a bare
 * null it reports every failed filter plus a `primaryRejectReason` (first
 * gate that killed the candidate) and `rejectionStage`.
 */
export function evaluateOpportunity(input: {
  candles: Candle[];
  costPct: number;
  scanScore: number | null;
  mid: number;
  cfg?: OpportunityConfig;
}): OpportunityVerdict {
  const cfg = input.cfg ?? OPPORTUNITY_DEFAULTS;
  const filters: OpportunityRejection["filters"] = [];
  const fail = (stage: OpportunityRejection["stage"], reason: string): OpportunityVerdict => ({
    opportunity: null,
    rejection: { stage, primaryRejectReason: reason, filters },
  });

  const dir = detectDirection(input.candles, cfg.minMomentumPct);
  filters.push({
    filterName: "momentum_direction", result: dir ? "PASS" : "FAIL",
    actualValue: null, threshold: cfg.minMomentumPct, operator: ">|minMomentumPct|",
    reason: "EMA9/EMA21 cross must agree with the 6-candle return",
  });
  if (!dir) return fail("STRATEGY", "No directional edge — EMA cross and momentum disagree or momentum too weak");

  const stops = dynamicStops(input.candles, input.costPct, cfg);
  if (!stops) return fail("MARKET_FILTER", "ATR unavailable — insufficient or degenerate candles");

  const gross = stops.tpPct;
  const net = gross - input.costPct;
  const rr = stops.tpPct / stops.slPct;
  const costShare = gross > 0 ? input.costPct / gross : 1;

  filters.push(
    { filterName: "net_return", result: net >= cfg.minNetReturnPct ? "PASS" : "FAIL",
      actualValue: round2(net), threshold: cfg.minNetReturnPct, operator: ">=",
      reason: "expected net return after costs" },
    { filterName: "risk_reward", result: rr >= cfg.minRiskReward ? "PASS" : "FAIL",
      actualValue: Math.round(rr * 100) / 100, threshold: cfg.minRiskReward, operator: ">=",
      reason: "tp/sl distance ratio" },
    { filterName: "cost_share", result: input.costPct <= gross * 0.5 ? "PASS" : "FAIL",
      actualValue: Math.round(costShare * 1000) / 10, threshold: 50, operator: "<=",
      reason: "cost as % of gross move — must stay under half" },
  );
  if (net < cfg.minNetReturnPct) return fail("COST", `Expected net return ${net.toFixed(2)}% below minimum ${cfg.minNetReturnPct}%`);
  if (input.costPct > gross * 0.5) return fail("COST", `Trading cost eats ${(costShare * 100).toFixed(0)}% of the gross edge`);
  if (rr < cfg.minRiskReward) return fail("RISK", `Risk/reward ${rr.toFixed(2)} below minimum ${cfg.minRiskReward}`);

  const opportunity = computeOpportunity(input)!;
  return { opportunity, rejection: null };
}

/**
 * Score one candidate pair. `metrics` is the scalping scanner's PairMetrics
 * (spread/depth/slippage/cost/volume) — reused so live and analysis agree.
 */
export function computeOpportunity(input: {
  candles: Candle[];
  costPct: number;          // round-trip cost from the scanner (fee+spread+slippage)
  scanScore: number | null; // scanner's composite 0..100
  mid: number;              // entry reference — book mid or last price
  cfg?: OpportunityConfig;
}): OpportunityCalc | null {
  const cfg = input.cfg ?? OPPORTUNITY_DEFAULTS;
  const dir = detectDirection(input.candles, cfg.minMomentumPct);
  if (!dir) return null;
  const stops = dynamicStops(input.candles, input.costPct, cfg);
  if (!stops) return null;

  const gross = stops.tpPct;
  const net = gross - input.costPct;
  const rr = stops.tpPct / stops.slPct;
  // reject: thin net edge, poor RR, or cost eating more than half the gross move
  if (net < cfg.minNetReturnPct || rr < cfg.minRiskReward || input.costPct > gross * 0.5) return null;

  const long = dir.direction === "LONG";
  const entry = input.mid;
  // confidence = scanner composite × momentum strength × net-edge margin
  const momentumBoost = clamp(Math.abs(dir.momentumPct) / 0.5, 0, 1) * 25;
  const edgeBoost = clamp(net / Math.max(input.costPct, 0.05) / 2, 0, 1) * 25;
  const score = clamp((input.scanScore ?? 50) * 0.5 + momentumBoost + edgeBoost, 0, 100);

  const reasons: string[] = [
    `جهت ${long ? "صعودی" : "نزولی"}: مومنتوم ${dir.momentumPct.toFixed(2)}٪`,
    `حد سود داینامیک ${stops.tpPct.toFixed(2)}٪ (ATR ${stops.atrPct.toFixed(2)}٪)`,
    `بازده خالص تخمینی ${net.toFixed(2)}٪ بعد از هزینه ${input.costPct.toFixed(2)}٪`,
    `ریسک/ریوارد ${rr.toFixed(1)}`,
  ];

  return {
    direction: dir.direction,
    entryPrice: entry,
    stopLossPct: round2(stops.slPct),
    takeProfitPct: round2(stops.tpPct),
    stopLossPrice: round8(long ? entry * (1 - stops.slPct / 100) : entry * (1 + stops.slPct / 100)),
    takeProfitPrice: round8(long ? entry * (1 + stops.tpPct / 100) : entry * (1 - stops.tpPct / 100)),
    grossReturnPct: round2(gross),
    totalCostPct: round2(input.costPct),
    netReturnPct: round2(net),
    riskReward: Math.round(rr * 10) / 10,
    score: Math.round(score),
    reasons,
  };
}

/**
 * Walk-forward replay of the scanner logic on historical candles — the same
 * detectDirection + dynamicStops, then simulate the trade: entry at next
 * candle open, exit on first TP/SL touch or horizon timeout. Costs deducted.
 */
export function backtestScanner(params: {
  candles: Candle[];
  costPct: number;
  cfg?: OpportunityConfig;
  warmup?: number;
  /** optional tracer — emits per-candidate filter results, rejections and
   *  opportunity lifecycles so a losing scan can be diagnosed */
  tracer?: import("@/modules/trace/tracer").Tracer;
  symbol?: string;
}): {
  totalSignals: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;
} {
  const cfg = params.cfg ?? OPPORTUNITY_DEFAULTS;
  const warmup = params.warmup ?? 40;
  const cost = params.costPct;
  const tracer = params.tracer;
  let wins = 0, losses = 0, timeouts = 0, totalPnl = 0;
  const pnls: number[] = [];

  for (let i = warmup; i < params.candles.length - cfg.horizonCandles - 1; i++) {
    const window = params.candles.slice(0, i + 1);
    const c0 = params.candles[i];
    const oid = `opp-${tracer?.runId ?? "local"}-${i}`;
    if (tracer) tracer.counters.totalEvaluations++;

    const dir = detectDirection(window, cfg.minMomentumPct);
    if (!dir) {
      tracer?.emit({
        stage: "SCANNER", event: "CANDIDATE_REJECTED",
        refId: oid, symbol: params.symbol, barIndex: i, candleTs: c0.time,
        data: {
          rejectionStage: "STRATEGY",
          primaryRejectReason: "No directional edge",
          failedFilters: ["momentum_direction"],
        },
      });
      tracer?.reject("STRATEGY", "No directional edge");
      continue;
    }
    const stops = dynamicStops(window, cost, cfg);
    if (!stops) continue;
    const rr = stops.tpPct / stops.slPct;
    const net = stops.tpPct - cost;
    const reject =
      net < cfg.minNetReturnPct
        ? { stage: "COST", reason: `Net ${net.toFixed(2)}% < min ${cfg.minNetReturnPct}%` }
        : rr < cfg.minRiskReward
          ? { stage: "RISK", reason: `RR ${rr.toFixed(2)} < min ${cfg.minRiskReward}` }
          : null;
    if (reject) {
      tracer?.emit({
        stage: "SCANNER", event: "CANDIDATE_REJECTED",
        refId: oid, symbol: params.symbol, barIndex: i, candleTs: c0.time,
        data: { rejectionStage: reject.stage, primaryRejectReason: reject.reason,
          netPct: net, riskReward: rr, costPct: cost },
      });
      tracer?.reject(reject.stage, reject.reason);
      continue;
    }
    if (tracer) { tracer.counters.signals++; tracer.counters.executedTrades++; }

    const entry = params.candles[i + 1].open;
    const long = dir.direction === "LONG";
    const tp = long ? entry * (1 + stops.tpPct / 100) : entry * (1 - stops.tpPct / 100);
    const sl = long ? entry * (1 - stops.slPct / 100) : entry * (1 + stops.slPct / 100);

    tracer?.emit({
      stage: "ENTRY", event: "OPPORTUNITY_OPENED", important: true,
      refId: oid, symbol: params.symbol, barIndex: i + 1, candleTs: params.candles[i + 1].time,
      data: {
        opportunityTraceId: oid, direction: dir.direction,
        signalTimestamp: c0.time, signalPrice: c0.close,
        entryPrice: entry, tpPrice: tp, slPrice: sl,
        atrPct: stops.atrPct, costPct: cost,
        grossExpectedReturnPct: stops.tpPct, netExpectedReturnPct: net,
        executionModel: "NEXT_BAR_OPEN", // causal — fills on the bar after the signal
      },
    });

    let pnl: number | null = null;
    let exitReason = "TIMEOUT";
    let exitTs = 0;
    let ambiguous = false;
    for (let j = i + 1; j < Math.min(i + 1 + cfg.horizonCandles, params.candles.length); j++) {
      const c = params.candles[j];
      const hitTp = long ? c.high >= tp : c.low <= tp;
      const hitSl = long ? c.low <= sl : c.high >= sl;
      if (hitTp && hitSl) {
        pnl = -stops.slPct; losses++; exitReason = "AMBIGUOUS_EXIT"; exitTs = c.time; ambiguous = true;
        tracer?.emit({
          stage: "POSITION", event: "AMBIGUOUS_EXIT", important: true,
          refId: oid, symbol: params.symbol, barIndex: j, candleTs: c.time,
          data: { warning: "AMBIGUOUS_EXIT", resolvedTo: "STOP_LOSS", policy: "CONSERVATIVE",
            candleHigh: c.high, candleLow: c.low },
        });
        if (tracer) tracer.counters.ambiguousExits++;
        break;
      }
      if (hitTp) { pnl = stops.tpPct - cost; wins++; exitReason = "TAKE_PROFIT"; exitTs = c.time; break; }
      if (hitSl) { pnl = -stops.slPct; losses++; exitReason = "STOP_LOSS"; exitTs = c.time; break; }
    }
    if (pnl === null) {
      const lastC = params.candles[Math.min(i + cfg.horizonCandles, params.candles.length - 1)];
      const drift = long ? (lastC.close - entry) / entry : (entry - lastC.close) / entry;
      pnl = drift * 100 - cost;
      exitTs = lastC.time;
      timeouts++;
    }
    pnls.push(pnl);
    totalPnl += pnl;
    tracer?.emit({
      stage: "EXIT", event: "OPPORTUNITY_CLOSED", important: true,
      refId: oid, symbol: params.symbol, candleTs: exitTs,
      data: { exitReason, netPnlPct: pnl, costPct: cost, ambiguousExit: ambiguous || undefined,
        holdingCandles: Math.round((exitTs - params.candles[i + 1].time) / (c0.time ? c0.time - (params.candles[i - 1]?.time ?? c0.time) : 1)) || undefined },
    });
    if (tracer) {
      tracer.counters.closedTrades++;
      if (pnl > 0) { tracer.counters.winningTrades++; tracer.counters.grossProfit += pnl; }
      else { tracer.counters.losingTrades++; tracer.counters.grossLoss += Math.abs(pnl); }
      tracer.counters.netProfit += pnl;
      if (exitReason === "TAKE_PROFIT") tracer.counters.tpCount++;
      else if (exitReason === "STOP_LOSS" || exitReason === "AMBIGUOUS_EXIT") tracer.counters.slCount++;
      else tracer.counters.otherExitCount++;
    }
  }

  tracer?.summary();
  const n = pnls.length;
  return {
    totalSignals: n, wins, losses, timeouts,
    winRate: n ? (wins / n) * 100 : 0,
    avgPnlPct: n ? totalPnl / n : 0,
    totalPnlPct: totalPnl,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round8 = (v: number) => Math.round(v * 1e8) / 1e8;
