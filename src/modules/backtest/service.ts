import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { TIMEFRAMES } from "@/shared/constants";
import { enqueue, QUEUE_NAMES, type BacktestJobData } from "@/infrastructure/queue/queues";
import { effectiveLimits, backtestUsage, isSubscriptionActive } from "@/modules/subscriptions/service";
import { latestVersion } from "@/modules/strategies/service";
import { getCandles } from "@/modules/pairs/service";
import { runBacktest, type BacktestResult } from "./engine";
import { runMmBacktest } from "./mm-engine";
import { readMmConfig } from "@/modules/trading/market-making";
import { obiBacktestSignal } from "@/modules/trading/orderbook-imbalance";
import { isSymbolicKind, symbolicSignalFn } from "@/modules/trading/symbolic-engines";
import type { Candle } from "@/modules/exchanges/types";
import { getSetting } from "@/modules/settings/service";
import { notify } from "@/modules/notifications/service";
import { logActivity } from "@/modules/activity/service";
import { logger } from "@/infrastructure/logging/logger";
import { idempotencyKey as newIdemKey, parseJson } from "@/shared/utils";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";

/** Extract dynamic SL/TP config from an enabled ATR indicator. */
export function atrStopsFromIndicators(
  indicators: { name: string; parameters: string; enabled: boolean }[],
): { period: number; slMultiplier: number; tpMultiplier: number } | undefined {
  const ind = indicators.find((i) => i.enabled && i.name.toUpperCase() === "ATR");
  if (!ind) return undefined;
  const p = parseJson<Record<string, number>>(ind.parameters, {});
  return {
    period: p.period ?? 14,
    slMultiplier: p.slMultiplier ?? 1.5,
    tpMultiplier: p.tpMultiplier ?? 2.5,
  };
}

/**
 * Backtest orchestration.
 * Quota rule: consumed ONLY when the backtest completes with a valid result.
 * System/Worker/API/data errors never consume quota.
 */

export async function requestBacktest(opts: {
  userId: string;
  strategyId: string;
  versionId?: string;
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  feePct?: number;
  slippagePct?: number;
  partialFill?: boolean;
  idempotencyKey?: string;
}) {
  const { subscription, backtestLimit, unlimited } = await effectiveLimits(opts.userId);
  if (!unlimited) {
    if (!subscription || !isSubscriptionActive(subscription.status, subscription.expiresAt)) {
      throw new AppError("SUBSCRIPTION_EXPIRED", 402);
    }
    const used = await backtestUsage(opts.userId);
    if (used >= backtestLimit) throw new AppError("INSUFFICIENT_QUOTA", 402);
  }

  const strategy = await prisma.strategy.findFirst({
    where: { id: opts.strategyId, userId: opts.userId, status: { not: "DELETED" } },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404);

  const version = opts.versionId
    ? await prisma.strategyVersion.findFirst({ where: { id: opts.versionId, strategyId: strategy.id } })
    : await latestVersion(strategy.id);
  if (!version) throw new AppError("STRATEGY_NOT_READY", 400);
  if (!TIMEFRAMES.includes(version.timeframe as never)) throw new AppError("INVALID_TIMEFRAME", 400);

  const key = opts.idempotencyKey ?? newIdemKey();
  const dup = await prisma.backtest.findUnique({ where: { idempotencyKey: key } });
  if (dup) return dup;

  const feePct = opts.feePct ?? (await getSetting<number>("BACKTEST_FEE_PCT"));
  const slippagePct = opts.slippagePct ?? (await getSetting<number>("BACKTEST_SLIPPAGE_PCT"));

  const backtest = await prisma.backtest.create({
    data: {
      userId: opts.userId,
      strategyId: strategy.id,
      versionId: version.id,
      symbol: version.symbol,
      timeframe: version.timeframe,
      startDate: opts.startDate,
      endDate: opts.endDate,
      initialBalance: opts.initialBalance,
      feePct,
      slippagePct,
      partialFill: opts.partialFill ?? false,
      status: "QUEUED",
      idempotencyKey: key,
    },
  });

  await prisma.strategy.update({
    where: { id: strategy.id },
    data: { status: "BACKTESTING" },
  });

  try {
    await enqueue<BacktestJobData>(QUEUE_NAMES.BACKTEST, "run", { backtestId: backtest.id });
  } catch {
    // Redis unavailable → run inline so dev works without docker
    logger.warn("redis unavailable — running backtest inline", { module: "backtest" });
    void executeBacktest(backtest.id);
  }

  await logActivity({ userId: opts.userId, action: "BACKTEST", entityType: "backtest", entityId: backtest.id });
  return backtest;
}

/** Worker entrypoint — executes a queued backtest. */
export async function executeBacktest(backtestId: string): Promise<BacktestResult | null> {
  const bt = await prisma.backtest.findUnique({
    where: { id: backtestId },
    include: { version: { include: { indicators: true } }, user: true },
  });
  if (!bt || !bt.version) throw new AppError("NOT_FOUND", 404);

  await prisma.backtest.update({
    where: { id: backtestId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  try {
    const candles = await getCandles({
      symbol: bt.symbol,
      timeframe: bt.timeframe,
      start: bt.startDate,
      end: bt.endDate,
    });
    if (candles.length < 100) throw new AppError("INSUFFICIENT_DATA", 422, { candles: candles.length });

    const result = await runAndPersist(bt, await buildIndicatorConfigs(bt));

    await notify({
      userId: bt.userId, type: "BACKTEST_COMPLETED", severity: "SUCCESS",
      title: "بک‌تست تکمیل شد",
      body: `بک‌تست استراتژی روی ${bt.symbol} تکمیل شد. سود خالص: ${result.profitPct.toFixed(2)}٪`,
      metadata: { backtestId: bt.id, profitPct: result.profitPct },
    });
    return result;
  } catch (err) {
    await prisma.backtest.update({
      where: { id: bt.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message : "unknown", completedAt: new Date() },
    });
    await prisma.strategy.update({ where: { id: bt.strategyId }, data: { status: "DRAFT" } }).catch(() => {});
    logger.error("backtest failed", { module: "backtest", errorCode: String(err) });
    return null;
  }
}

async function buildIndicatorConfigs(bt: {
  version: { indicators: { name: string; parameters: string; weight: number; enabled: boolean; buyCondition: string; sellCondition: string }[] } | null;
}) {
  return (bt.version?.indicators ?? []).map((i) => ({
    name: i.name,
    parameters: parseJson(i.parameters, {}),
    weight: i.weight,
    enabled: i.enabled,
    buyCondition: i.buyCondition,
    sellCondition: i.sellCondition,
  })) as StrategyIndicatorConfig[];
}

/**
 * Shared execution+persistence — runs the engine for an already-created
 * Backtest row and atomically writes trades + metrics + COMPLETED status.
 * Used by executeBacktest (queue path) and smart-select (direct path).
 */
export async function runAndPersist(
  bt: {
    id: string;
    userId: string;
    strategyId: string;
    symbol: string;
    timeframe: string;
    startDate: Date;
    endDate: Date;
    initialBalance: number;
    feePct: number;
    slippagePct: number;
    executionDelayMs: number;
    partialFill: boolean;
    version: {
      kind: string;
      config: string;
      buyThreshold: number;
      sellThreshold: number;
      riskPerTradePct: number;
      stopLossPct: number;
      takeProfitPct: number;
      trailingStop: boolean;
      trailingStopPct: number | null;
      indicators: { name: string; parameters: string; enabled: boolean }[];
    } | null;
  },
  indicators: StrategyIndicatorConfig[],
  candles?: Candle[],
): Promise<BacktestResult> {
  const data =
    candles ??
    (await getCandles({
      symbol: bt.symbol,
      timeframe: bt.timeframe,
      start: bt.startDate,
      end: bt.endDate,
    }));
  if (data.length < 100) throw new AppError("INSUFFICIENT_DATA", 422, { candles: data.length });
  const v = bt.version!;

  const kind = v.kind ?? "SIGNAL";
  let result: BacktestResult;
  if (kind === "MARKET_MAKING") {
    // simulated MM — quotes rest between candles, fills on range touches
    const pair = await prisma.pair.findUnique({ where: { symbol: bt.symbol } });
    const quoteCur = /IRT$/.test(bt.symbol) ? "IRT" : "USDT";
    result = runMmBacktest({
      candles: data,
      cfg: readMmConfig(v.config),
      initialBalance: bt.initialBalance,
      feePct: bt.feePct,
      pricePrecision: pair?.pricePrecision ?? (quoteCur === "IRT" ? 0 : 2),
      amountPrecision: pair?.amountPrecision ?? 8,
      minAmount: pair?.minAmount,
    });
  } else {
    result = runBacktest({
      candles: data,
      indicators,
      buyThreshold: v.buyThreshold,
      sellThreshold: v.sellThreshold,
      initialBalance: bt.initialBalance,
      riskPerTradePct: v.riskPerTradePct,
      stopLossPct: v.stopLossPct,
      takeProfitPct: v.takeProfitPct,
      trailingStop: v.trailingStop,
      trailingStopPct: v.trailingStopPct ?? undefined,
      atrStops: atrStopsFromIndicators(v.indicators),
      feePct: bt.feePct,
      slippagePct: bt.slippagePct,
      executionDelayMs: bt.executionDelayMs,
      partialFill: bt.partialFill,
      // OBI — candle imbalance proxy; symbolic kinds — their own engine signals
      signalFn: kind === "ORDER_BOOK_IMBALANCE"
        ? obiBacktestSignal(data, v.config, v.buyThreshold, v.sellThreshold)
        : isSymbolicKind(kind)
          ? symbolicSignalFn(kind, data, v.config)
          : undefined,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.backtestTrade.createMany({
      data: result.trades.map((t) => ({
        backtestId: bt.id,
        side: t.side,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        amount: t.amount,
        fee: t.fee,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        entryTime: new Date(t.entryTime),
        exitTime: new Date(t.exitTime),
        exitReason: t.exitReason,
      })),
    });
    await tx.backtest.update({
      where: { id: bt.id },
      data: {
        status: "COMPLETED",
        progress: 100,
        quotaConsumed: true, // ← quota consumed only on success
        finalBalance: result.finalBalance,
        netProfit: result.netProfit,
        profitPct: result.profitPct,
        winRate: result.winRate,
        lossRate: result.lossRate,
        totalTrades: result.totalTrades,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgProfit: result.avgProfit,
        avgLoss: result.avgLoss,
        maxDrawdown: result.maxDrawdown,
        profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : 9999,
        largestWin: result.largestWin,
        largestLoss: result.largestLoss,
        avgTradeDurationMin: result.avgTradeDurationMin,
        equityCurve: JSON.stringify(result.equityCurve.filter((_, i) => i % 10 === 0)),
        results: JSON.stringify({ breakdown: true, kind }),
        completedAt: new Date(),
      },
    });
    await tx.strategy.update({
      where: { id: bt.strategyId },
      data: { status: "READY" },
    });
  });

  return result;
}
