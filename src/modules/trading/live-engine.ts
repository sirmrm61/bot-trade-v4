import { prisma } from "@/infrastructure/database/prisma";
import { adapterForUser, publicAdapter } from "@/modules/exchanges/registry";
import { computeSignal } from "@/modules/signals/engine";
import { orderBookImbalance, readObiConfig, smoothObi } from "./orderbook-imbalance";
import { isSymbolicKind, symbolicLast, symbolicWarmup } from "./symbolic-engines";
import { marketMakingTick, paperMarketMakingTick, cancelStrategyOrders } from "./market-making";
import { atr } from "@/modules/indicators/engine";
import { atrStopsFromIndicators } from "@/modules/backtest/service";
import { enforceRisk } from "./risk-engine";
import { placeOrder } from "./order-engine";
import { AppError } from "@/shared/errors";
import { logger } from "@/infrastructure/logging/logger";
import { notify } from "@/modules/notifications/service";
import { getCandles } from "@/modules/pairs/service";
import { getSetting } from "@/modules/settings/service";
import { parseJson } from "@/shared/utils";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";
import { effectiveLimits, liveUsage, isSubscriptionActive } from "@/modules/subscriptions/service";

/**
 * Live Trading Engine — runs inside the trading worker, never in
 * the Next.js request cycle. Each tick:
 *   fetch candles → indicators → signal → risk → order → monitor → SL/TP
 */

/** Pre-flight checks when a user starts a live strategy. */
export async function startLiveStrategy(opts: {
  userId: string;
  strategyId: string;
  versionId?: string;
  allocatedCapital: number;
  mode?: "REAL" | "PAPER";
}) {
  const mode = opts.mode ?? "REAL";
  const { subscription, liveLimit, unlimited } = await effectiveLimits(opts.userId);

  // 1. plan check  2. active live count  3. time validity — admins bypass
  if (!unlimited) {
    if (!subscription || !isSubscriptionActive(subscription.status, subscription.expiresAt)) {
      throw new AppError("SUBSCRIPTION_EXPIRED", 402);
    }
    if (subscription.status === "GRACE_PERIOD") {
      throw new AppError("SUBSCRIPTION_EXPIRED", 402, { reason: "grace period — no new live" });
    }
    if ((await liveUsage(opts.userId)) >= liveLimit) throw new AppError("LIVE_LIMIT_REACHED", 402);
  }

  // 4. API connection — paper mode only reads public market data, no account needed
  if (mode === "REAL") {
    const account = await prisma.exchangeAccount.findUnique({
      where: { userId_exchange: { userId: opts.userId, exchange: "NOBITEX" } },
    });
    if (!account || account.status !== "CONNECTED") throw new AppError("NO_EXCHANGE_ACCOUNT", 412);
  }

  // 5. capital sanity
  if (opts.allocatedCapital <= 0) throw new AppError("VALIDATION", 400, { reason: "capital" });

  // 6. strategy must have a successful backtest (READY/LIVE-eligible)
  const strategy = await prisma.strategy.findFirst({
    where: { id: opts.strategyId, userId: opts.userId, status: { not: "DELETED" } },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404);
  const version = opts.versionId
    ? await prisma.strategyVersion.findFirst({ where: { id: opts.versionId, strategyId: strategy.id } })
    : await prisma.strategyVersion.findFirst({
        where: { strategyId: strategy.id }, orderBy: { versionNumber: "desc" },
      });
  if (!version) throw new AppError("STRATEGY_NOT_READY", 400);
  // paper mode never touches real funds so it needs no backtest gate;
  // REAL requires one for every kind (order-book kinds use simulated backtests)
  if (mode === "REAL") {
    const hasBacktest = await prisma.backtest.findFirst({
      where: { strategyId: strategy.id, status: "COMPLETED" },
    });
    if (!hasBacktest) throw new AppError("STRATEGY_NOT_READY", 400, { reason: "backtest required before live" });
  }

  // 7. create job
  const live = await prisma.liveStrategy.create({
    data: {
      userId: opts.userId,
      strategyId: strategy.id,
      versionId: version.id,
      symbol: version.symbol,
      allocatedCapital: opts.allocatedCapital,
      mode,
      status: "STARTING",
    },
  });
  await prisma.strategy.update({ where: { id: strategy.id }, data: { status: "LIVE" } });
  const { enqueue, QUEUE_NAMES } = await import("@/infrastructure/queue/queues");
  await enqueue(QUEUE_NAMES.LIVE_STRATEGY, "start", { liveStrategyId: live.id, action: "START" });
  await notify({
    userId: opts.userId, type: "SYSTEM", severity: "SUCCESS",
    title: mode === "PAPER" ? "تست زنده فعال شد" : "استراتژی فعال شد",
    body: mode === "PAPER"
      ? `استراتژی «${strategy.name}» روی ${version.symbol} در حالت تست (بدون سفارش واقعی) فعال شد.`
      : `استراتژی «${strategy.name}» روی ${version.symbol} فعال شد.`,
  });
  return live;
}

export async function pauseLiveStrategy(userId: string, liveId: string) {
  const live = await prisma.liveStrategy.findFirst({ where: { id: liveId, userId } });
  if (!live) throw new AppError("NOT_FOUND", 404);
  // Pause: no NEW trades; open trades keep being managed.
  return prisma.liveStrategy.update({ where: { id: live.id }, data: { status: "PAUSED" } });
}

export async function stopLiveStrategy(
  userId: string,
  liveId: string,
  stopPolicy: "CLOSE_ALL" | "KEEP_MANAGING",
) {
  const live = await prisma.liveStrategy.findFirst({ where: { id: liveId, userId } });
  if (!live) throw new AppError("NOT_FOUND", 404);
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: { status: "STOPPING", stopPolicy },
  });
  const { enqueue, QUEUE_NAMES } = await import("@/infrastructure/queue/queues");
  await enqueue(QUEUE_NAMES.LIVE_STRATEGY, "stop", { liveStrategyId: live.id, action: "STOP" });
  return live;
}

/**
 * One trading tick for a live strategy — called by the BullMQ worker
 * on a repeatable schedule.
 */
export async function liveTick(liveStrategyId: string): Promise<void> {
  const live = await prisma.liveStrategy.findUnique({
    where: { id: liveStrategyId },
    include: { version: { include: { indicators: { orderBy: { sortOrder: "asc" } } } } },
  });
  if (!live || !live.version) return;
  if (["STOPPED", "ERROR"].includes(live.status)) return;

  // STOPPING → execute chosen stop policy
  if (live.status === "STOPPING") {
    await executeStopPolicy(live);
    return;
  }

  const paper = live.mode === "PAPER";

  try {
    // paper mode reads only public market data — no user credentials needed
    const adapter = paper ? publicAdapter() : await adapterForUser(live.userId, "NOBITEX", "live-engine");

    // ---- market making — own quoting loop, handles PAUSED internally
    if (live.version.kind === "MARKET_MAKING") {
      if (paper) await paperMarketMakingTick(live, adapter);
      else await marketMakingTick(live, adapter);
      if (live.circuitBreakerFailures > 0) {
        await prisma.liveStrategy.update({
          where: { id: live.id }, data: { circuitBreakerFailures: 0, status: "RUNNING" },
        });
      }
      return;
    }

    // ---- manage open trades (SL / TP / trailing) — runs even when PAUSED
    const openTrades = await prisma.trade.findMany({
      where: { liveStrategyId: live.id, status: "OPEN" },
    });
    const ticker = await adapter.getTicker(live.symbol);
    for (const trade of openTrades) {
      await manageOpenTrade(live, trade, ticker.last, paper);
    }

    if (live.status === "PAUSED") return;

    // ---- signal evaluation
    let signal: "BUY" | "SELL" | "HOLD";
    let score: number;
    let obiEma: number | undefined;
    let symLabel = "";
    let candles: Awaited<ReturnType<typeof getCandles>> | null = null;

    if (live.version.kind === "ORDER_BOOK_IMBALANCE") {
      const book = await adapter.getOrderBook(live.symbol);
      const obiCfg = readObiConfig(live.version.config);
      const prevStats = parseJson<{ obiEma?: number }>(live.stats, {});
      obiEma = smoothObi(orderBookImbalance(book, obiCfg.depthLevels), prevStats.obiEma, obiCfg.emaPeriod);
      score = obiEma;
      signal = score >= live.version.buyThreshold ? "BUY"
        : score <= live.version.sellThreshold ? "SELL" : "HOLD";
    } else if (isSymbolicKind(live.version.kind)) {
      // symbolic engines are candle-native — fetch enough history for their windows
      const need = Math.max(200, symbolicWarmup(live.version.kind, live.version.config));
      candles = await getCandles({
        symbol: live.symbol,
        timeframe: live.version.timeframe,
        start: new Date(Date.now() - need * tfMs(live.version.timeframe)),
        end: new Date(),
      });
      if (candles.length < Math.min(60, need / 2)) return;
      const r = symbolicLast(live.version.kind, candles, live.version.config);
      signal = r.signal;
      score = r.score;
      symLabel = r.label;
    } else {
      candles = await getCandles({
        symbol: live.symbol,
        timeframe: live.version.timeframe,
        start: new Date(Date.now() - 200 * tfMs(live.version.timeframe)),
        end: new Date(),
      });
      if (candles.length < 60) return;

      const indicators: StrategyIndicatorConfig[] = live.version.indicators.map((i) => ({
        name: i.name,
        parameters: parseJson(i.parameters, {}),
        weight: i.weight,
        enabled: i.enabled,
        buyCondition: i.buyCondition,
        sellCondition: i.sellCondition,
      }));
      const r = computeSignal(
        indicators, candles, live.version.buyThreshold, live.version.sellThreshold,
      );
      signal = r.signal;
      score = r.score;
    }
    const prevStats = parseJson<{ obiHist?: { t: number; v: number }[] }>(live.stats, {});
    const obiHist = obiEma !== undefined
      ? [...(prevStats.obiHist ?? []), { t: Date.now(), v: obiEma }].slice(-200)
      : prevStats.obiHist;
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: {
        lastSignalAt: new Date(),
        stats: JSON.stringify({
          lastScore: score,
          lastSignal: signal,
          ...(symLabel ? { symLabel } : {}),
          ...(obiEma !== undefined ? { obiEma } : {}),
          ...(obiHist ? { obiHist } : {}),
        }),
      },
    });

    if (signal !== "BUY") return;

    // duplicate trade prevention — position + order + signal checks
    const openPosition = await prisma.trade.findFirst({
      where: { liveStrategyId: live.id, symbol: live.symbol, status: "OPEN" },
    });
    if (openPosition) return;
    const openOrder = await prisma.order.findFirst({
      where: {
        liveStrategyId: live.id, symbol: live.symbol,
        status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
      },
    });
    if (openOrder) return;
    if (live.lastSignalAt && live.stats) {
      const prev = parseJson<{ lastSignal?: string; lastScore?: number }>(live.stats, {});
      // skip identical consecutive signals handled naturally by position checks
      void prev;
    }

    // sizing: risk-based position — ATR stops when configured, else fixed pct
    const atrStops = atrStopsFromIndicators(live.version.indicators);
    if (atrStops && !candles) {
      candles = await getCandles({
        symbol: live.symbol,
        timeframe: live.version.timeframe,
        start: new Date(Date.now() - 200 * tfMs(live.version.timeframe)),
        end: new Date(),
      });
    }
    const atrNow = atrStops && candles?.length ? atr(candles, atrStops.period).at(-1) : undefined;
    const slPrice = atrStops && atrNow && Number.isFinite(atrNow)
      ? ticker.last - atrNow * atrStops.slMultiplier
      : ticker.last * (1 - live.version.stopLossPct / 100);
    const tpPrice = atrStops && atrNow && Number.isFinite(atrNow)
      ? ticker.last + atrNow * atrStops.tpMultiplier
      : ticker.last * (1 + live.version.takeProfitPct / 100);
    const stopDistPct = Math.max(((ticker.last - slPrice) / ticker.last) * 100, 0.1);

    const riskCapital = live.allocatedCapital * (live.version.riskPerTradePct / 100);
    const maxPosition = live.allocatedCapital * (live.version.maxPositionPct / 100);
    const notional = Math.min(riskCapital * (100 / stopDistPct), maxPosition);
    const amount = notional / ticker.last;
    if (amount <= 0) return;

    // paper mode: sizing vs virtual capital only — real balance/risk checks don't apply
    if (!paper) {
      await enforceRisk(
        {
          userId: live.userId,
          liveStrategyId: live.id,
          symbol: live.symbol,
          side: "BUY",
          amount,
          price: ticker.last,
          allocatedCapital: live.allocatedCapital,
          riskPerTradePct: live.version.riskPerTradePct,
          maxPositionPct: live.version.maxPositionPct,
        },
        adapter,
      );
    }

    // create trade + entry order (idempotent)
    const trade = await prisma.trade.create({
      data: {
        userId: live.userId,
        liveStrategyId: live.id,
        symbol: live.symbol,
        side: "LONG",
        entryPrice: ticker.last,
        amount,
        invested: notional,
        stopLossPrice: slPrice,
        takeProfitPrice: tpPrice,
        trailingPeak: ticker.last,
      },
    });
    if (!paper) {
      await placeOrder(
        {
          userId: live.userId,
          liveStrategyId: live.id,
          tradeId: trade.id,
          symbol: live.symbol,
          side: "BUY",
          type: live.version.orderType as "MARKET" | "LIMIT",
          amount,
          price: live.version.orderType === "LIMIT" ? ticker.last : undefined,
        },
        `entry:${trade.id}`,
      );
    }

    await notify({
      userId: live.userId, type: "TRADE_OPENED", severity: "INFO",
      title: paper ? "معامله‌ی تست باز شد" : "معامله باز شد",
      body: `خرید ${live.symbol} در قیمت ${ticker.last}`,
      metadata: { tradeId: trade.id, paper },
    });

    if (live.circuitBreakerFailures > 0) {
      await prisma.liveStrategy.update({
        where: { id: live.id }, data: { circuitBreakerFailures: 0, status: "RUNNING" },
      });
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : "UNKNOWN";
    logger.error("live tick failed", { module: "trading", liveStrategyId, errorCode: code });
    const failures = live.circuitBreakerFailures + 1;
    const threshold = await getSetting<number>("CIRCUIT_BREAKER_THRESHOLD");
    const status = failures >= threshold ? "DEGRADED" : live.status;
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { circuitBreakerFailures: failures, status, lastError: code },
    });
    if (status === "DEGRADED") {
      await notify({
        userId: live.userId, type: "API_ERROR", severity: "ERROR",
        title: "خطای صرافی", body: "استراتژی به دلیل خطاهای متوالی صرافی در وضعیت کاهش‌یافته قرار گرفت.",
      });
    }
  }
}

async function manageOpenTrade(
  live: { id: string; userId: string; symbol: string; versionId: string },
  trade: {
    id: string; entryPrice: number; amount: number; trailingPeak: number | null;
    stopLossPrice: number | null; takeProfitPrice: number | null;
  },
  price: number,
  paper = false,
) {
  const version = await prisma.strategyVersion.findUnique({ where: { id: live.versionId } });
  if (!version) return;

  let exitReason: string | null = null;
  const peak = Math.max(trade.trailingPeak ?? trade.entryPrice, price);
  if (price <= (trade.stopLossPrice ?? 0)) exitReason = "STOP_LOSS";
  else if (trade.takeProfitPrice && price >= trade.takeProfitPrice) exitReason = "TAKE_PROFIT";
  else if (version.trailingStop && version.trailingStopPct && peak > trade.entryPrice) {
    if (price <= peak * (1 - version.trailingStopPct / 100)) exitReason = "TRAILING_STOP";
  }

  if (peak !== trade.trailingPeak) {
    await prisma.trade.update({ where: { id: trade.id }, data: { trailingPeak: peak } });
  }
  if (!exitReason) return;

  // close position — sell via order engine (paper: simulated fill at ticker)
  await prisma.trade.update({ where: { id: trade.id }, data: { status: "CLOSING" } });
  if (!paper) {
    await placeOrder(
      {
        userId: live.userId, liveStrategyId: live.id, tradeId: trade.id,
        symbol: live.symbol, side: "SELL", type: "MARKET", amount: trade.amount,
      },
      `exit:${trade.id}:${exitReason}`,
    );
  }
  const proceeds = trade.amount * price;
  const pnl = proceeds - trade.amount * trade.entryPrice;
  await prisma.trade.update({
    where: { id: trade.id },
    data: { status: "CLOSED", exitPrice: price, exitReason, pnl, pnlPct: (pnl / (trade.amount * trade.entryPrice)) * 100, closedAt: new Date() },
  });
  await notify({
    userId: live.userId,
    type: exitReason === "TAKE_PROFIT" ? "TP_HIT" : exitReason === "STOP_LOSS" ? "SL_HIT" : "TRADE_CLOSED",
    severity: pnl >= 0 ? "SUCCESS" : "WARNING",
    title: "معامله بسته شد",
    body: `${live.symbol} با دلیل ${exitReason} بسته شد. سود/زیان: ${pnl.toFixed(0)}`,
    metadata: { tradeId: trade.id, exitReason, pnl },
  });
}

async function executeStopPolicy(live: { id: string; userId: string; symbol: string; stopPolicy: string | null; mode: string }) {
  const paper = live.mode === "PAPER";
  // resting orders never outlive the strategy — market makers especially
  await cancelStrategyOrders(live.id, live.userId).catch(() => {});
  if (live.stopPolicy === "CLOSE_ALL") {
    const openTrades = await prisma.trade.findMany({
      where: { liveStrategyId: live.id, status: "OPEN" },
    });
    const adapter = paper
      ? publicAdapter()
      : await adapterForUser(live.userId, "NOBITEX", "stop-policy").catch(() => null);
    const price = adapter ? (await adapter.getTicker(live.symbol).catch(() => null))?.last ?? 0 : 0;
    for (const trade of openTrades) {
      if (!paper) {
        await placeOrder(
          { userId: live.userId, liveStrategyId: live.id, tradeId: trade.id, symbol: live.symbol, side: "SELL", type: "MARKET", amount: trade.amount },
          `stopclose:${trade.id}`,
        );
      }
      const pnl = trade.amount * ((price || trade.entryPrice) - trade.entryPrice);
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          status: "CLOSED", exitReason: "STOP_POLICY",
          exitPrice: price || trade.entryPrice, closedAt: new Date(),
          ...(paper ? { pnl, pnlPct: (pnl / (trade.amount * trade.entryPrice)) * 100 } : {}),
        },
      });
    }
  }
  // KEEP_MANAGING → leave open trades; they get monitored until closed
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: { status: "STOPPED", stoppedAt: new Date() },
  });
  const ls = await prisma.liveStrategy.findUnique({ where: { id: live.id } });
  if (ls) await prisma.strategy.update({ where: { id: ls.strategyId }, data: { status: "STOPPED" } });
}

function tfMs(tf: string): number {
  const m: Record<string, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 };
  return m[tf] ?? 3_600_000;
}
