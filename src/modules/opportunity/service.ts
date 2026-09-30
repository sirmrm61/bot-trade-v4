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
  computeOpportunity, backtestScanner,
  OPPORTUNITY_DEFAULTS, type OpportunityCalc,
} from "./engine";
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
): Promise<{ created: number; opportunities: unknown[]; scanned: number; ranked: number }> {
  const count = clamp(Math.trunc(opts.count ?? 10), 1, 25);
  const tf = opts.candleTimeframe ?? "5m";

  const result = await rankPairs({ market: opts.market });
  const ranked = result.pairs.filter((p) => p.status === "RANKED" && p.score !== null);
  if (ranked.length === 0) {
    throw new AppError("INSUFFICIENT_DATA", 422, { reason: "no ranked pairs from scanner" });
  }

  const end = new Date();
  const start = new Date(end.getTime() - CANDLE_TARGET * tfMs(tf));
  const rows: {
    calc: OpportunityCalc; p: PairRank;
  }[] = [];

  for (const p of ranked.slice(0, MAX_SCANNED)) {
    if (rows.length >= count) break;
    try {
      const candles = await getCandles({ symbol: p.symbol, timeframe: tf, start, end, exchange: p.exchange });
      if (candles.length < MIN_CANDLES) continue;
      const mid = p.metrics.mid ?? p.metrics.markPrice ?? candles[candles.length - 1].close;
      const costPct = p.metrics.roundTripCostPct ?? DEFAULT_COST_PCT;
      const calc = computeOpportunity({ candles, costPct, scanScore: p.score, mid });
      if (calc) rows.push({ calc, p });
    } catch {
      logger.warn("opportunity candle eval failed", { module: "opportunity", symbol: p.symbol });
    }
  }

  const created: unknown[] = [];
  for (const { calc, p } of rows) {
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
        }),
        horizonCandles: OPPORTUNITY_DEFAULTS.horizonCandles,
        expiresAt: new Date(Date.now() + OPPORTUNITY_DEFAULTS.horizonCandles * tfMs(tf)),
      },
    });
    created.push(opp);
  }

  await logActivity({ userId, action: "OPPORTUNITY_SCAN", entityType: "opportunity" });
  logger.info("opportunity scan", {
    module: "opportunity", userId, market: opts.market ?? "ALL",
    ranked: ranked.length, created: created.length,
  });
  return { created: created.length, opportunities: created, scanned: result.meta.totalPairs, ranked: ranked.length };
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
): Promise<{ approved: boolean; violations: string[] }> {
  const violations: string[] = [];
  if (cfg.emergencyStop) violations.push("EMERGENCY_STOP");

  const active = await prisma.liveStrategy.findMany({
    where: { userId, status: { in: ["RUNNING", "PAUSED", "STARTING", "DEGRADED"] } },
    select: { symbol: true, exchange: true },
  });
  if (active.length >= cfg.maxOpenPositions) violations.push("MAX_OPEN_POSITIONS");

  // correlation — same base asset already running
  const base = opp.symbol.replace(/IRT|USDT|M$/g, "").replace(/-/g, "");
  const sameBase = active.filter((l) =>
    l.exchange === opp.exchange &&
    l.symbol.replace(/IRT|USDT|M$/g, "").replace(/-/g, "") === base,
  );
  if (sameBase.length >= cfg.maxSameBasePositions) violations.push("CORRELATED_POSITION");

  // daily loss — sum of today's closed-trade pnlPct
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const todayClosed = await prisma.trade.findMany({
    where: { userId, closedAt: { gte: dayStart }, status: "CLOSED" },
    select: { pnlPct: true, symbol: true },
  });
  const dailyLoss = todayClosed.reduce((s, t) => s + Math.min(t.pnlPct ?? 0, 0), 0);
  if (dailyLoss <= -cfg.maxDailyLossPct) violations.push("MAX_DAILY_LOSS");

  // consecutive losses — newest first
  const recent = await prisma.trade.findMany({
    where: { userId, status: "CLOSED" },
    orderBy: { closedAt: "desc" },
    take: cfg.maxConsecutiveLosses,
    select: { pnlPct: true },
  });
  if (recent.length === cfg.maxConsecutiveLosses && recent.every((t) => (t.pnlPct ?? 0) <= 0)) {
    violations.push("CONSECUTIVE_LOSSES");
  }

  // per-symbol cooldown after its last closed trade
  const lastSame = await prisma.trade.findFirst({
    where: { userId, symbol: opp.symbol, status: "CLOSED" },
    orderBy: { closedAt: "desc" },
    select: { closedAt: true },
  });
  if (lastSame?.closedAt && Date.now() - lastSame.closedAt.getTime() < cfg.cooldownMinutes * 60_000) {
    violations.push("COOLDOWN");
  }

  return { approved: violations.length === 0, violations };
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

  const risk = await checkPortfolioRisk(userId, opp);
  if (!risk.approved) throw new AppError("RISK_VIOLATION", 422, { violations: risk.violations });

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
  opts: { symbol: string; exchange: string; timeframe: string; days?: number; costPct?: number },
) {
  const days = clamp(opts.days ?? 14, 3, 90);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const candles = await getCandles({
    symbol: opts.symbol, timeframe: opts.timeframe, start, end, exchange: opts.exchange,
  });
  if (candles.length < 200) throw new AppError("INSUFFICIENT_DATA", 422, { candles: candles.length });
  const result = backtestScanner({ candles, costPct: opts.costPct ?? DEFAULT_COST_PCT });
  await logActivity({ userId, action: "OPPORTUNITY_BACKTEST", entityType: "opportunity" });
  return { ...result, candles: candles.length, symbol: opts.symbol, timeframe: opts.timeframe, days };
}
