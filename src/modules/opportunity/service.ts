import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { rankPairs } from "@/modules/scalping/service";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { logActivity } from "@/modules/activity/service";
import { logger } from "@/infrastructure/logging/logger";
import { clamp } from "@/shared/utils";
import { INDICATORS } from "@/modules/indicators/registry";
import type { Condition } from "@/modules/indicators/engine";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";
import {
  evaluateOpportunity, backtestScanner,
  OPPORTUNITY_DEFAULTS, type OpportunityCalc,
} from "./engine";
import { Tracer, makeScanRunId, opportunityTraceId } from "@/modules/trace/tracer";
import type { PairRank } from "@/modules/scalping/types";

/**
 * Market Opportunity Scanner — sits on top of the scalping scanner's ranked
 * pairs, adds a directional decision + dynamic ATR/cost-aware trade plan, and
 * persists every opportunity with its full feature snapshot so outcomes can be
 * backfilled later (ML dataset — same contract as SignalLog).
 */

const MAX_SCANNED = 20;         // candle fetches per scan are bounded
const CANDLE_TARGET = 120;      // enough for EMA21 + ATR14 warm-up + momentum
const MIN_CANDLES = 60;
const DEFAULT_COST_PCT = 0.7;

export interface ScanOpts {
  market?: "SPOT" | "PERPETUAL";
  count?: number;              // max opportunities persisted
  candleTimeframe?: string;    // "5m" default
}

export async function scanOpportunities(
  userId: string,
  opts: ScanOpts = {},
): Promise<{ created: number; opportunities: unknown[]; scanned: number; ranked: number; scanRunId: string }> {
  const count = clamp(Math.trunc(opts.count ?? 10), 1, 25);
  const tf = opts.candleTimeframe ?? "5m";
  const tracer = new Tracer(makeScanRunId(), { level: "SUMMARY" });

  const result = await rankPairs({ market: opts.market, quote: "USDT" });
  const ranked = result.pairs.filter((p) => p.status === "RANKED" && p.score !== null);
  if (ranked.length === 0) {
    throw new AppError("INSUFFICIENT_DATA", 422, { reason: "no ranked pairs from scanner" });
  }
  tracer.counters.totalEvaluations = ranked.length;

  const end = new Date();
  const start = new Date(end.getTime() - CANDLE_TARGET * tfMs(tf));
  const rows: {
    calc: OpportunityCalc; p: PairRank; oid: string;
  }[] = [];

  for (const p of ranked.slice(0, MAX_SCANNED)) {
    if (rows.length >= count) break;
    const oid = opportunityTraceId(tracer.runId, p.symbol, Date.now());
    try {
      const candles = await getCandles({ symbol: p.symbol, timeframe: tf, start, end, exchange: p.exchange });
      if (candles.length < MIN_CANDLES) {
        tracer.reject("MARKET_FILTER", "Insufficient candle history");
        continue;
      }
      const mid = p.metrics.mid ?? p.metrics.markPrice ?? candles[candles.length - 1].close;
      const costPct = p.metrics.roundTripCostPct ?? DEFAULT_COST_PCT;
      const verdict = evaluateOpportunity({ candles, costPct, scanScore: p.score, mid });
      if (!verdict.opportunity) {
        // every failed filter + the primary reason, so an empty scan is diagnosable
        tracer.emit({
          stage: "SCANNER", event: "CANDIDATE_REJECTED", important: true,
          refId: oid, symbol: p.symbol, candleTs: candles.at(-1)?.time,
          data: {
            scanScore: p.score, costPct,
            rejectionStage: verdict.rejection!.stage,
            primaryRejectReason: verdict.rejection!.primaryRejectReason,
            filters: verdict.rejection!.filters,
            marketSnapshot: {
              spreadPct: p.metrics.spreadPct, depthUsd: p.metrics.depthUsd,
              volumeUsd24h: p.metrics.volumeUsd24h, slippagePct: p.metrics.slippagePct,
            },
          },
        });
        tracer.reject(verdict.rejection!.stage, verdict.rejection!.primaryRejectReason);
        continue;
      }
      tracer.counters.signals++;
      tracer.emit({
        stage: "SCANNER", event: "CANDIDATE_ACCEPTED", important: true,
        refId: oid, symbol: p.symbol, candleTs: candles.at(-1)?.time,
        data: {
          scanScore: p.score, costPct, filters: verdict.rejection ? [] : undefined,
          direction: verdict.opportunity.direction,
          netReturnPct: verdict.opportunity.netReturnPct,
          riskReward: verdict.opportunity.riskReward,
          score: verdict.opportunity.score,
        },
      });
      rows.push({ calc: verdict.opportunity, p, oid });
    } catch {
      logger.warn("opportunity candle eval failed", { module: "opportunity", symbol: p.symbol });
    }
  }

  const created: unknown[] = [];
  for (const { calc, p, oid } of rows) {
    const opp = await prisma.opportunity.create({
      data: {
        userId, exchange: p.exchange, symbol: p.symbol,
        marketType: p.marketType, direction: calc.direction,
        timeframe: tf,
        entryPrice: calc.entryPrice,
        stopLossPct: calc.stopLossPct, takeProfitPct: calc.takeProfitPct,
        stopLossPrice: calc.stopLossPrice, takeProfitPrice: calc.takeProfitPrice,
        grossReturnPct: calc.grossReturnPct, totalCostPct: calc.totalCostPct,
        netReturnPct: calc.netReturnPct, riskReward: calc.riskReward,
        score: calc.score, reasons: JSON.stringify(calc.reasons),
        features: JSON.stringify({
          scanScore: p.score, metrics: p.metrics,
          completeness: p.dataQuality.completeness,
          opportunityTraceId: oid, scanRunId: tracer.runId,
        }),
        horizonCandles: OPPORTUNITY_DEFAULTS.horizonCandles,
        expiresAt: new Date(Date.now() + OPPORTUNITY_DEFAULTS.horizonCandles * tfMs(tf)),
      },
    });
    created.push(opp);
  }

  // persist the scan trace — every rejection reason survives for diagnosis
  const summary = tracer.summary();
  try {
    await prisma.traceEvent.createMany({
      data: tracer.events.map((e) => ({
        runId: e.runId, backtestId: null, refId: e.refId ?? null, seq: e.seq,
        ts: BigInt(e.ts), stage: e.stage, event: e.event,
        symbol: e.symbol ?? null, barIndex: e.barIndex ?? null,
        candleTs: e.candleTs != null ? BigInt(e.candleTs) : null,
        data: e.data ? JSON.stringify(e.data) : null,
      })),
    });
  } catch (err) {
    logger.warn("scan trace persist failed", { module: "opportunity", err: String(err) });
  }

  await logActivity({ userId, action: "OPPORTUNITY_SCAN", entityType: "opportunity" });
  logger.info("opportunity scan", {
    module: "opportunity", userId, market: opts.market ?? "ALL",
    ranked: ranked.length, created: created.length, scanRunId: tracer.runId,
    rejections: summary.rejectionsByReason,
  });
  return { created: created.length, opportunities: created, scanned: result.meta.totalPairs, ranked: ranked.length, scanRunId: tracer.runId };
}

/**
 * Outcome evaluator — for OPEN opportunities whose horizon elapsed, replay the
 * candles since entry and decide TP_HIT / SL_HIT / TIMEOUT. Called lazily from
 * the list route so results converge without a worker dependency.
 */
export async function evaluateOutcomes(limit = 30): Promise<number> {
  const stale = await prisma.opportunity.findMany({
    where: { status: "OPEN", expiresAt: { lt: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let evaluated = 0;
  for (const opp of stale) {
    try {
      const candles = await getCandles({
        symbol: opp.symbol, timeframe: opp.timeframe,
        start: opp.createdAt, end: new Date(opp.createdAt.getTime() + opp.horizonCandles * tfMs(opp.timeframe) + tfMs(opp.timeframe)),
        exchange: opp.exchange,
      });
      const post = candles.filter((c) => c.time > opp.createdAt.getTime());
      let outcome = "TIMEOUT";
      let pnl = opp.direction === "LONG"
        ? ((post.at(-1)?.close ?? opp.entryPrice) - opp.entryPrice) / opp.entryPrice * 100
        : (opp.entryPrice - (post.at(-1)?.close ?? opp.entryPrice)) / opp.entryPrice * 100;
      for (const c of post) {
        const long = opp.direction === "LONG";
        const hitTp = long ? c.high >= opp.takeProfitPrice : c.low <= opp.takeProfitPrice;
        const hitSl = long ? c.low <= opp.stopLossPrice : c.high >= opp.stopLossPrice;
        if (hitTp && hitSl) { outcome = "SL_HIT"; pnl = -opp.stopLossPct; break; }
        if (hitTp) { outcome = "TP_HIT"; pnl = opp.takeProfitPct; break; }
        if (hitSl) { outcome = "SL_HIT"; pnl = -opp.stopLossPct; break; }
      }
      await prisma.opportunity.update({
        where: { id: opp.id },
        data: { status: "EXPIRED", outcome, outcomePnlPct: Math.round((pnl - opp.totalCostPct) * 100) / 100, evaluatedAt: new Date() },
      });
      evaluated++;
    } catch {
      await prisma.opportunity.update({ where: { id: opp.id }, data: { status: "EXPIRED", outcome: "NO_DATA", evaluatedAt: new Date() } }).catch(() => {});
    }
  }
  return evaluated;
}

/** Portfolio-level risk guard — independent of per-strategy riskCheck. */
export interface PortfolioRiskConfig {
  maxOpenPositions: number;
  maxDailyLossPct: number;       // sum of today's realized pnlPct (capital-weighted approx)
  maxConsecutiveLosses: number;
  cooldownMinutes: number;       // after a loss on the same symbol
  maxSameBasePositions: number;  // correlation control
  emergencyStop: boolean;
}

export const DEFAULT_PORTFOLIO_RISK: PortfolioRiskConfig = {
  maxOpenPositions: 5,
  maxDailyLossPct: 10,
  maxConsecutiveLosses: 4,
  cooldownMinutes: 30,
  maxSameBasePositions: 1,
  emergencyStop: false,
};

export async function checkPortfolioRisk(
  userId: string,
  opp: { symbol: string; exchange: string },
  cfg: PortfolioRiskConfig = DEFAULT_PORTFOLIO_RISK,
): Promise<{ approved: boolean; violations: string[]; details: string[] }> {
  const violations: string[] = [];
  const details: string[] = [];
  const push = (code: string, detail: string) => { violations.push(code); details.push(detail); };
  if (cfg.emergencyStop) push("EMERGENCY_STOP", "توقف اضطراری فعال است — تا وقتی خاموش نشود معامله‌ی جدیدی باز نمی‌شود");

  const active = await prisma.liveStrategy.findMany({
    where: { userId, status: { in: ["RUNNING", "PAUSED", "STARTING", "DEGRADED"] } },
    select: { symbol: true, exchange: true },
  });
  if (active.length >= cfg.maxOpenPositions) {
    push("MAX_OPEN_POSITIONS", `${active.length} استراتژی فعال دارید — سقف ${cfg.maxOpenPositions} پوزیشن باز است. یکی را متوقف کنید`);
  }

  // correlation — same base asset already running
  const base = opp.symbol.replace(/IRT|USDT|M$/g, "").replace(/-/g, "");
  const sameBase = active.filter((l) =>
    l.exchange === opp.exchange &&
    l.symbol.replace(/IRT|USDT|M$/g, "").replace(/-/g, "") === base,
  );
  if (sameBase.length >= cfg.maxSameBasePositions) {
    push("CORRELATED_POSITION", `هم‌پوشانی ریسکی: ${sameBase.length} استراتژی فعال روی دارایی پایه‌ی ${base} وجود دارد — سقف ${cfg.maxSameBasePositions}`);
  }

  // daily loss — sum of today's closed-trade pnlPct
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const todayClosed = await prisma.trade.findMany({
    where: { userId, closedAt: { gte: dayStart }, status: "CLOSED" },
    select: { pnlPct: true, symbol: true },
  });
  const dailyLoss = todayClosed.reduce((s, t) => s + Math.min(t.pnlPct ?? 0, 0), 0);
  if (dailyLoss <= -cfg.maxDailyLossPct) {
    push("MAX_DAILY_LOSS", `زیان تحقق‌یافته‌ی امروز ${dailyLoss.toFixed(1)}٪ به حد مجاز ${cfg.maxDailyLossPct}٪- رسیده — فردا دوباره تلاش کنید`);
  }

  // consecutive losses — newest first
  const recent = await prisma.trade.findMany({
    where: { userId, status: "CLOSED" },
    orderBy: { closedAt: "desc" },
    take: cfg.maxConsecutiveLosses,
    select: { pnlPct: true },
  });
  if (recent.length === cfg.maxConsecutiveLosses && recent.every((t) => (t.pnlPct ?? 0) <= 0)) {
    push("CONSECUTIVE_LOSSES", `${cfg.maxConsecutiveLosses} معامله‌ی اخیر پشت‌سرهم زیان‌ده بوده‌اند — ورود جدید موقتاً قفل است`);
  }

  // per-symbol cooldown after its last closed trade
  const lastSame = await prisma.trade.findFirst({
    where: { userId, symbol: opp.symbol, status: "CLOSED" },
    orderBy: { closedAt: "desc" },
    select: { closedAt: true },
  });
  if (lastSame?.closedAt && Date.now() - lastSame.closedAt.getTime() < cfg.cooldownMinutes * 60_000) {
    const wait = Math.ceil(cfg.cooldownMinutes - (Date.now() - lastSame.closedAt.getTime()) / 60_000);
    push("COOLDOWN", `کول‌داون نماد: آخرین معامله‌ی ${opp.symbol} تازه بسته شده — ${wait} دقیقه‌ی دیگر صبر کنید`);
  }

  return { approved: violations.length === 0, violations, details };
}

/**
 * Execute an opportunity — materializes it as a strategy + paper/live start
 * request. PAPER always allowed (no real orders). REAL requires the portfolio
 * risk check AND the existing strategy backtest gate (via startLiveStrategy).
 */
export async function executeOpportunity(
  userId: string,
  opportunityId: string,
  opts: { mode: "PAPER" | "REAL"; allocatedCapital: number },
) {
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, userId } });
  if (!opp) throw new AppError("NOT_FOUND", 404);
  if (opp.status !== "OPEN") throw new AppError("VALIDATION", 400, { reason: "opportunity expired/executed" });
  if (new Date() > opp.expiresAt) throw new AppError("VALIDATION", 400, { reason: "opportunity expired" });
  // shorts only exist on perpetuals — a SHORT idea on a spot pair can't execute
  if (opp.direction === "SHORT" && opp.marketType !== "PERPETUAL") {
    throw new AppError("VALIDATION", 400, { reason: "short requires a perpetual market" });
  }

  // risk gate — PAPER always allowed (no real orders). REAL requires the
  // portfolio risk check.
  if (opts.mode === "REAL") {
    const risk = await checkPortfolioRisk(userId, opp);
    if (!risk.approved) {
      throw new AppError("RISK_VIOLATION", 422, { violations: risk.violations }, risk.details.join("؛ "));
    }
  }

  const { createStrategy } = await import("@/modules/strategies/service");
  const { startLiveStrategy } = await import("@/modules/trading/live-engine");
  const dirLabel = opp.direction === "LONG" ? "لانگ" : "شورت";
  const { strategy } = await createStrategy(userId, {
    name: `فرصت ${dirLabel} ${opp.symbol}`,
    description: `از اسکنر فرصت — امتیاز ${opp.score} · RR ${opp.riskReward} · بازده خالص ${opp.netReturnPct}٪`,
    kind: "SIGNAL",
    symbol: opp.symbol,
    exchange: opp.exchange,
    timeframe: opp.timeframe,
    buyThreshold: 0.1, sellThreshold: -0.1,
    riskPerTradePct: 2,
    stopLossPct: opp.stopLossPct,
    takeProfitPct: opp.takeProfitPct,
    trailingStop: false,
    maxPositionPct: 100,
    orderType: "LIMIT",
    market: opp.marketType === "PERPETUAL" ? "FUTURES" : "SPOT",
    ...(opp.marketType === "PERPETUAL" ? { leverage: 2 } : {}),
    // SIGNAL kind needs ≥1 enabled scoring indicator — registry defaults.
    // Thresholds are loose (±0.1) so the first mild signal enters promptly;
    // the real trade plan lives in the dynamic SL/TP above.
    indicators: INDICATORS.map((d): StrategyIndicatorConfig => ({
      name: d.key,
      enabled: d.defaultEnabled,
      weight: d.scoring ? d.defaultWeight : 0,
      parameters: d.defaultParams,
      buyCondition: d.defaultBuyCondition as Condition | undefined,
      sellCondition: d.defaultSellCondition as Condition | undefined,
    })),
  }, "AI");

  const live = await startLiveStrategy({
    userId, strategyId: strategy.id,
    allocatedCapital: opts.allocatedCapital,
    mode: opts.mode,
  });
  await prisma.opportunity.update({
    where: { id: opp.id },
    data: { status: "EXECUTED", liveStrategyId: live.id },
  });
  return { strategyId: strategy.id, liveStrategyId: live.id };
}

/** Scanner-level backtest — replays the opportunity logic on history. */
export async function runScannerBacktest(
  userId: string,
  opts: { symbol: string; exchange: string; timeframe: string; days?: number; costPct?: number; traceLevel?: "OFF" | "SUMMARY" | "FULL" },
) {
  const days = clamp(opts.days ?? 14, 3, 90);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const candles = await getCandles({
    symbol: opts.symbol, timeframe: opts.timeframe, start, end, exchange: opts.exchange,
  });
  if (candles.length < 200) throw new AppError("INSUFFICIENT_DATA", 422, { candles: candles.length });
  const tracer = new Tracer(makeScanRunId(), { level: opts.traceLevel ?? "SUMMARY" });
  const result = backtestScanner({ candles, costPct: opts.costPct ?? DEFAULT_COST_PCT, tracer, symbol: opts.symbol });
  if (tracer.events.length > 0) {
    try {
      await prisma.traceEvent.createMany({
        data: tracer.events.map((e) => ({
          runId: e.runId, backtestId: null, refId: e.refId ?? null, seq: e.seq,
          ts: BigInt(e.ts), stage: e.stage, event: e.event,
          symbol: e.symbol ?? opts.symbol, barIndex: e.barIndex ?? null,
          candleTs: e.candleTs != null ? BigInt(e.candleTs) : null,
          data: e.data ? JSON.stringify(e.data) : null,
        })),
      });
    } catch (err) {
      logger.warn("scanner backtest trace persist failed", { module: "opportunity", err: String(err) });
    }
  }
  await logActivity({ userId, action: "OPPORTUNITY_BACKTEST", entityType: "opportunity" });
  return { ...result, candles: candles.length, symbol: opts.symbol, timeframe: opts.timeframe, days, scanRunId: tracer.runId, traceSummary: tracer.counters };
}
