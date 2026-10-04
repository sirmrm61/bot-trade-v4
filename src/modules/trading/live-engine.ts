import { prisma } from "@/infrastructure/database/prisma";
import { adapterForUser, publicAdapter } from "@/modules/exchanges/registry";
import { computeSignal } from "@/modules/signals/engine";
import { orderBookImbalance, readObiConfig, smoothObi, obiHysteresis } from "./orderbook-imbalance";
import { isSymbolicKind, symbolicLast, symbolicWarmup } from "./symbolic-engines";
import type { SymbolicKind } from "./symbolic-engines";
import {
  adaptConfig, decideEntry, readLearn, recordOutcome, smartEnabled,
  type SmartDetail,
} from "./smart";
import { marketMakingTick, paperMarketMakingTick, cancelStrategyOrders } from "./market-making";
import { logSignal, shouldLogEpisode, attachTradeOutcome, type SignalDecision } from "./signal-log";
import { readMarketConfig, readExchange, liquidationPrice, futuresPnl, SYMBOLIC_MAX_LEVERAGE } from "./futures";
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

/** after a stop-loss, same-side re-entry is blocked for this many candles */
const LOSS_COOLDOWN_BARS = 4;
/** N consecutive losing closes → strategy auto-pauses */
const LOSS_STREAK_LIMIT = 3;

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
  const exchange = readExchange(version.config);
  // 4. API connection on the strategy's exchange — paper mode only reads public market data
  if (mode === "REAL") {
    const account = await prisma.exchangeAccount.findUnique({
      where: { userId_exchange: { userId: opts.userId, exchange } },
    });
    if (!account || account.status !== "CONNECTED") throw new AppError("NO_EXCHANGE_ACCOUNT", 412);
  }
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
      exchange,
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
    const exchange = live.exchange || "NOBITEX";
    const adapter = paper ? publicAdapter(exchange) : await adapterForUser(live.userId, exchange, "live-engine");

    // ---- market making / grid — own quoting loops, handle PAUSED internally
    if (live.version.kind === "MARKET_MAKING" || live.version.kind === "GRID") {
      const { gridTick, paperGridTick } = await import("./grid");
      if (live.version.kind === "GRID") {
        if (paper) await paperGridTick(live, adapter);
        else await gridTick(live, adapter);
      } else if (paper) await paperMarketMakingTick(live, adapter);
      else await marketMakingTick(live, adapter);
      if (live.circuitBreakerFailures > 0 || live.status === "STARTING") {
        await prisma.liveStrategy.update({
          where: { id: live.id }, data: { circuitBreakerFailures: 0, status: "RUNNING" },
        });
      }
      return;
    }

    const marketCfg = readMarketConfig(live.version.config);
    const futures = marketCfg.market === "FUTURES";
    // symbolic engines have shown trend-blindness in production — cap their
    // leverage so a tight SL can't turn into a leveraged bleed
    if (isSymbolicKind(live.version.kind)) {
      marketCfg.leverage = Math.min(marketCfg.leverage, SYMBOLIC_MAX_LEVERAGE);
    }

    // ---- manage open trades (SL / TP / trailing / liquidation) — runs even when PAUSED
    const openTrades = await prisma.trade.findMany({
      where: { liveStrategyId: live.id, status: "OPEN" },
    });
    const ticker = await adapter.getTicker(live.symbol);
    // a venue returning a null/zero quote (e.g. symbol routed to the wrong
    // endpoint) must not reach sizing — exposure/0 = Infinity → NaN writes
    if (!Number.isFinite(ticker.last) || ticker.last <= 0) {
      throw new AppError("EXCHANGE_CONNECTION_FAILED", 502, { symbol: live.symbol, reason: "no usable price" });
    }

    // real futures: lazily resolve the exchange position id so exits can
    // use /positions/{id}/close instead of a counter-order
    if (futures && !paper && adapter.getOpenPositions) {
      const unresolved = openTrades.filter((t) => !t.exchangePositionId);
      if (unresolved.length) {
        const positions = await adapter.getOpenPositions(live.symbol).catch(() => []);
        for (const trade of unresolved) {
          const match = positions.find((p) => p.symbol === live.symbol && p.side === trade.side);
          if (match) {
            await prisma.trade.update({
              where: { id: trade.id },
              data: {
                exchangePositionId: match.id,
                ...(match.liquidationPrice ? { liquidationPrice: match.liquidationPrice } : {}),
              },
            });
            trade.exchangePositionId = match.id;
          }
        }
      }
    }

    for (const trade of openTrades) {
      await manageOpenTrade(live, trade, ticker.last, paper, futures ? adapter : null);
    }

    if (live.status === "PAUSED") return;

    // ---- signal evaluation
    let signal: "BUY" | "SELL" | "HOLD";
    let rawSignal: "BUY" | "SELL" | "HOLD" = "HOLD"; // engine output before smart veto — what gets logged
    let score: number;
    let obiEma: number | undefined;
    let obiCand: string | undefined;  // hysteresis: pending direction
    let obiCandN = 0;                 // hysteresis: ticks persisted so far
    let symLabel = "";
    let symNote: string | undefined;
    let smartPending: SmartDetail | null = null; // features captured at entry — consumed on close
    let smartSizeMult = 1;
    let smartVeto: string | undefined;
    let sigFeats: Record<string, unknown> = {};
    let sigContext: string | undefined;
    let candles: Awaited<ReturnType<typeof getCandles>> | null = null;

    if (live.version.kind === "ORDER_BOOK_IMBALANCE") {
      const book = await adapter.getOrderBook(live.symbol);
      const obiCfg = readObiConfig(live.version.config);
      const prevStats = parseJson<{ obiEma?: number; obiCand?: string; obiCandN?: number }>(live.stats, {});
      obiEma = smoothObi(orderBookImbalance(book, obiCfg.depthLevels), prevStats.obiEma, obiCfg.emaPeriod);
      score = obiEma;
      rawSignal = score >= live.version.buyThreshold ? "BUY"
        : score <= live.version.sellThreshold ? "SELL" : "HOLD";
      // hysteresis — a direction must persist `hysteresis` consecutive ticks
      // before it becomes a tradeable signal (raw books flip constantly)
      const gate = obiHysteresis(rawSignal, prevStats.obiCand, prevStats.obiCandN ?? 0, obiCfg.hysteresis);
      signal = gate.signal;
      obiCand = gate.cand;
      obiCandN = gate.candN;
      sigFeats = {
        obiEma, depthLevels: obiCfg.depthLevels, obiEmaPeriod: obiCfg.emaPeriod,
        hysteresis: obiCfg.hysteresis, persisted: obiCandN,
      };
    } else if (isSymbolicKind(live.version.kind)) {
      // symbolic engines are candle-native — fetch enough history for their windows
      const need = Math.max(200, symbolicWarmup(live.version.kind, live.version.config));
      candles = await getCandles({
        symbol: live.symbol,
        timeframe: live.version.timeframe,
        start: new Date(Date.now() - need * tfMs(live.version.timeframe)),
        end: new Date(),
        exchange,
      });
      if (candles.length < Math.min(60, need / 2)) return;
      const smartOn = smartEnabled(live.version.config);
      const learn = smartOn ? readLearn(live.stats) : null;
      const effConfig = learn
        ? adaptConfig(live.version.kind, live.version.config, learn)
        : live.version.config;
      const r = symbolicLast(live.version.kind, candles, effConfig);
      signal = r.signal;
      rawSignal = r.signal;
      score = r.score;
      symLabel = r.label;
      sigContext = r.detail?.context;
      sigFeats = { x: r.detail?.x, bucket: r.detail?.bucket, label: r.label };
      if (learn && r.detail && signal !== "HOLD") {
        const d = decideEntry(live.version.kind, learn, r.detail);
        smartPending = r.detail;
        smartSizeMult = d.sizeMult;
        sigFeats.smartScore = d.smartScore;
        sigFeats.sizeMult = d.sizeMult;
        sigFeats.learnN = learn.n;
        if (!d.allow) {
          signal = "HOLD";
          smartPending = null;
          smartVeto = d.veto ?? "smart";
          symNote = d.veto === "score" ? "وتوی هوشمند (امتیاز پایین)" : `وتوی هوشمند (${r.label})`;
        } else if (learn.n > 0) {
          symNote = `هوشمند: امتیاز ${(d.smartScore * 100) | 0}٪ · سایز ×${d.sizeMult.toFixed(2)}`;
        }
      }
    } else {
      candles = await getCandles({
        symbol: live.symbol,
        timeframe: live.version.timeframe,
        start: new Date(Date.now() - 200 * tfMs(live.version.timeframe)),
        end: new Date(),
        exchange,
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
      rawSignal = r.signal;
      score = r.score;
      sigFeats = { breakdown: r.breakdown };
    }
    const prevStats = parseJson<Record<string, unknown> & { obiHist?: { t: number; v: number }[]; sigEp?: string | null }>(live.stats, {});
    const obiHist = obiEma !== undefined
      ? [...(prevStats.obiHist ?? []), { t: Date.now(), v: obiEma }].slice(-200)
      : prevStats.obiHist;
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: {
        lastSignalAt: new Date(),
        ...(live.status === "STARTING" ? { status: "RUNNING" } : {}),
        stats: JSON.stringify({
          ...prevStats, // learn + pendingCtx survive every tick
          sigEp: rawSignal === "HOLD" ? null : rawSignal, // signal-episode dedupe key
          lastScore: score,
          lastSignal: signal,
          ...(symLabel ? { symLabel } : {}),
          ...(symNote ? { symNote } : { symNote: undefined }),
          ...(obiEma !== undefined ? { obiEma, obiCand, obiCandN } : {}),
          ...(obiHist ? { obiHist } : {}),
        }),
      },
    });

    // SignalLog — one row per signal episode (raw signal changes) or per entry.
    // Analytics only: every write inside is swallowed.
    const logDecision = (decision: SignalDecision, side?: "LONG" | "SHORT" | null, tradeId?: string) =>
      shouldLogEpisode(prevStats.sigEp, rawSignal, decision === "ENTERED")
        ? logSignal({
            liveStrategyId: live.id,
            userId: live.userId,
            exchange,
            symbol: live.symbol,
            kind: live.version.kind,
            signal: rawSignal as "BUY" | "SELL",
            score,
            side: side ?? null,
            decision,
            features: { ...sigFeats, ...(smartVeto ? { veto: smartVeto } : {}) },
            context: sigContext,
            tradeId,
          })
        : Promise.resolve();

    // signal → direction. shorts only exist in futures mode
    const side: "LONG" | "SHORT" | null =
      signal === "BUY" ? "LONG" : futures && signal === "SELL" ? "SHORT" : null;
    if (!side) {
      await logDecision(smartVeto ? "VETO_SMART" : "SKIP_SPOT_SHORT");
      return;
    }
    const long = side === "LONG";

    if (futures && !paper && !adapter.createFuturesOrder) {
      throw new AppError("FUTURES_UNSUPPORTED", 400, { reason: "adapter has no margin endpoints" });
    }

    // duplicate trade prevention — position + order + signal checks
    const openPosition = await prisma.trade.findFirst({
      where: { liveStrategyId: live.id, symbol: live.symbol, status: "OPEN" },
    });
    if (openPosition) {
      await logDecision("SKIP_OPEN_POSITION", side);
      return;
    }
    const openOrder = await prisma.order.findFirst({
      where: {
        liveStrategyId: live.id, symbol: live.symbol,
        status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
      },
    });
    if (openOrder) {
      await logDecision("SKIP_OPEN_ORDER", side);
      return;
    }

    // portfolio-level dedup — another live strategy of the same user must not
    // double the exposure on this symbol in the same direction
    const portfolioDup = await prisma.trade.findFirst({
      where: {
        userId: live.userId, symbol: live.symbol, side, status: "OPEN",
        liveStrategyId: { not: live.id },
        liveStrategy: { status: { in: ["STARTING", "RUNNING", "PAUSED", "DEGRADED"] } },
      },
    });
    if (portfolioDup) {
      await logDecision("SKIP_PORTFOLIO_DUP", side);
      return;
    }

    // post-loss cooldown — after a stop-loss/liquidation on this side the
    // signal must not re-enter the same direction for LOSS_COOLDOWN_BARS
    // candles (breaks the SL → instant re-entry revenge loop)
    const lastLoss = await prisma.trade.findFirst({
      where: {
        liveStrategyId: live.id, side, status: "CLOSED",
        exitReason: { in: ["STOP_LOSS", "LIQUIDATED"] },
      },
      orderBy: { closedAt: "desc" },
      select: { closedAt: true },
    });
    const cooldownMs = LOSS_COOLDOWN_BARS * tfMs(live.version.timeframe);
    if (lastLoss?.closedAt && Date.now() - lastLoss.closedAt.getTime() < cooldownMs) {
      await logDecision("SKIP_LOSS_COOLDOWN", side);
      return;
    }

    // sizing: risk-based position — ATR stops when configured, else fixed pct
    const atrStops = atrStopsFromIndicators(live.version.indicators);
    if (atrStops && !candles) {
      candles = await getCandles({
        symbol: live.symbol,
        timeframe: live.version.timeframe,
        start: new Date(Date.now() - 200 * tfMs(live.version.timeframe)),
        end: new Date(),
        exchange,
      });
    }
    const atrNow = atrStops && candles?.length ? atr(candles, atrStops.period).at(-1) : undefined;
    const useAtr = atrStops && atrNow && Number.isFinite(atrNow);
    const slPrice = useAtr
      ? long ? ticker.last - atrNow! * atrStops.slMultiplier : ticker.last + atrNow! * atrStops.slMultiplier
      : long ? ticker.last * (1 - live.version.stopLossPct / 100) : ticker.last * (1 + live.version.stopLossPct / 100);
    const tpPrice = useAtr
      ? long ? ticker.last + atrNow! * atrStops.tpMultiplier : ticker.last - atrNow! * atrStops.tpMultiplier
      : long ? ticker.last * (1 + live.version.takeProfitPct / 100) : ticker.last * (1 - live.version.takeProfitPct / 100);
    const liqPrice = futures ? liquidationPrice(ticker.last, side, marketCfg.leverage) : null;
    // the stop must sit inside the liquidation distance or the position
    // dies at liq before the stop ever fires
    const effSl = futures && liqPrice
      ? long ? Math.max(slPrice, liqPrice) : Math.min(slPrice, liqPrice)
      : slPrice;
    const stopDistPct = Math.max((Math.abs(ticker.last - effSl) / ticker.last) * 100, 0.1);

    // learned sizing — smart layer scales risk within [0.5, 1.75]; hard caps stay
    const riskCapital = live.allocatedCapital * (live.version.riskPerTradePct / 100) * smartSizeMult;
    const maxPosition = live.allocatedCapital * (live.version.maxPositionPct / 100);
    // exposure bounded by risk on the stop distance AND the position cap
    // (cap scales with leverage — margin posted stays bounded by capital)
    const leverage = futures ? marketCfg.leverage : 1;
    const exposure = Math.min(riskCapital * (100 / stopDistPct), maxPosition * leverage);
    const margin = exposure / leverage;   // wallet outlay (spot: exposure == margin)
    const amount = exposure / ticker.last;
    if (!Number.isFinite(amount) || amount <= 0) return;

    // paper mode: sizing vs virtual capital only — real balance/risk checks don't apply
    if (!paper) {
      await enforceRisk(
        {
          userId: live.userId,
          liveStrategyId: live.id,
          symbol: live.symbol,
          side: long ? "BUY" : "SELL",
          // risk engine sees margin usage, not leveraged exposure
          amount: margin / ticker.last,
          price: ticker.last,
          allocatedCapital: live.allocatedCapital,
          riskPerTradePct: live.version.riskPerTradePct,
          maxPositionPct: live.version.maxPositionPct,
          market: marketCfg.market,
          exchange,
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
        side,
        leverage,
        liquidationPrice: liqPrice,
        entryPrice: ticker.last,
        amount,
        invested: margin,
        stopLossPrice: effSl,
        takeProfitPrice: tpPrice,
        trailingPeak: ticker.last,
      },
    });
    await logDecision("ENTERED", side, trade.id);
    // stash the entry's learning context — consumed by recordOutcome on close
    if (smartPending) {
      const s = await prisma.liveStrategy.findUnique({ where: { id: live.id }, select: { stats: true } });
      const obj = parseJson<Record<string, unknown>>(s?.stats ?? "{}", {});
      await prisma.liveStrategy.update({
        where: { id: live.id },
        data: { stats: JSON.stringify({ ...obj, pendingCtx: { kind: live.version.kind, tradeId: trade.id, ...smartPending } }) },
      });
    }
    if (!paper) {
      await placeOrder(
        {
          userId: live.userId,
          liveStrategyId: live.id,
          tradeId: trade.id,
          symbol: live.symbol,
          side: long ? "BUY" : "SELL",
          type: live.version.orderType as "MARKET" | "LIMIT",
          amount,
          // nobitex margin orders always carry a reference price
          price: futures ? ticker.last : live.version.orderType === "LIMIT" ? ticker.last : undefined,
          ...(futures ? { futures: { leverage: marketCfg.leverage, positionSide: side } } : {}),
        },
        `entry:${trade.id}`,
      );
    }

    await notify({
      userId: live.userId, type: "TRADE_OPENED", severity: "INFO",
      title: paper ? "معامله‌ی تست باز شد" : "معامله باز شد",
      body: `${long ? "خرید" : "فروش (شورت)"} ${live.symbol} در قیمت ${ticker.last}${futures ? ` — لورج ${marketCfg.leverage}×` : ""}`,
      metadata: { tradeId: trade.id, paper, side, leverage },
    });

    if (live.circuitBreakerFailures > 0) {
      await prisma.liveStrategy.update({
        where: { id: live.id }, data: { circuitBreakerFailures: 0, status: "RUNNING" },
      });
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : "UNKNOWN";
    // UNKNOWN without a message is undiagnosable — always capture it
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("live tick failed", {
      module: "trading", liveStrategyId, errorCode: code,
      errorMessage: detail.slice(0, 300),
      errorName: err instanceof Error ? err.name : undefined,
    });
    const failures = live.circuitBreakerFailures + 1;
    const threshold = await getSetting<number>("CIRCUIT_BREAKER_THRESHOLD");
    const status = failures >= threshold ? "DEGRADED" : live.status;
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { circuitBreakerFailures: failures, status, lastError: `${code}: ${detail.slice(0, 160)}` },
    });
    // notify only on the transition into DEGRADED — not on every failed tick
    if (status === "DEGRADED" && live.status !== "DEGRADED") {
      await notify({
        userId: live.userId, type: "API_ERROR", severity: "ERROR",
        title: "خطای صرافی", body: "استراتژی به دلیل خطاهای متوالی صرافی در وضعیت کاهش‌یافته قرار گرفت.",
      });
    }
  }
}

interface TradeLike {
  id: string;
  entryPrice: number;
  amount: number;
  invested: number;
  side: string;
  leverage: number;
  liquidationPrice: number | null;
  exchangePositionId: string | null;
  trailingPeak: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}

async function manageOpenTrade(
  live: { id: string; userId: string; symbol: string; versionId: string },
  trade: TradeLike,
  price: number,
  paper = false,
  /** non-null only for real futures — used for position close + counter-orders */
  futuresAdapter: { closePosition?: (id: string) => Promise<boolean>; createFuturesOrder?: unknown } | null = null,
) {
  const version = await prisma.strategyVersion.findUnique({ where: { id: live.versionId } });
  if (!version) return;

  const long = trade.side !== "SHORT";
  const futures = trade.leverage > 1 || futuresAdapter !== null;

  // extreme price since entry — long tracks the max, short the min
  const peak = long
    ? Math.max(trade.trailingPeak ?? trade.entryPrice, price)
    : Math.min(trade.trailingPeak ?? trade.entryPrice, price);

  let exitReason: string | null = null;
  if (futures && trade.liquidationPrice && (long ? price <= trade.liquidationPrice : price >= trade.liquidationPrice)) {
    exitReason = "LIQUIDATED";
  } else if (long ? price <= (trade.stopLossPrice ?? 0) : trade.stopLossPrice !== null && price >= trade.stopLossPrice) {
    exitReason = "STOP_LOSS";
  } else if (trade.takeProfitPrice && (long ? price >= trade.takeProfitPrice : price <= trade.takeProfitPrice)) {
    exitReason = "TAKE_PROFIT";
  } else if (version.trailingStop && version.trailingStopPct && (long ? peak > trade.entryPrice : peak < trade.entryPrice)) {
    const trail = long ? peak * (1 - version.trailingStopPct / 100) : peak * (1 + version.trailingStopPct / 100);
    if (long ? price <= trail : price >= trail) exitReason = "TRAILING_STOP";
  }

  if (peak !== trade.trailingPeak) {
    await prisma.trade.update({ where: { id: trade.id }, data: { trailingPeak: peak } });
  }
  if (!exitReason) return;

  // close position (paper: simulated fill at ticker)
  await prisma.trade.update({ where: { id: trade.id }, data: { status: "CLOSING" } });
  if (!paper) {
    let closedByPosition = false;
    if (futures && trade.exchangePositionId && futuresAdapter?.closePosition) {
      closedByPosition = await futuresAdapter.closePosition(trade.exchangePositionId).catch(() => false);
      if (closedByPosition) {
        // bookkeeping order row — audit trail mirrors the exchange close
        await prisma.order.create({
          data: {
            userId: live.userId, liveStrategyId: live.id, tradeId: trade.id,
            symbol: live.symbol, side: long ? "SELL" : "BUY", type: "MARKET",
            amount: trade.amount, status: "FILLED", filledAmount: trade.amount,
            avgFillPrice: price, closedAt: new Date(),
            idempotencyKey: `closepos:${trade.id}:${exitReason}`,
            metadata: JSON.stringify({ market: "FUTURES", positionId: trade.exchangePositionId }),
          },
        }).catch(() => {});
      }
    }
    if (!closedByPosition) {
      await placeOrder(
        {
          userId: live.userId, liveStrategyId: live.id, tradeId: trade.id,
          symbol: live.symbol, side: long ? "SELL" : "BUY", type: "MARKET",
          amount: trade.amount,
          ...(futures ? { price, futures: { leverage: trade.leverage, positionSide: long ? "LONG" : "SHORT" } } : {}),
        },
        `exit:${trade.id}:${exitReason}`,
      );
    }
  }

  const pnl = exitReason === "LIQUIDATED"
    ? -trade.invested // isolated margin — the posted margin is lost
    : futuresPnl(trade.entryPrice, price, trade.amount, long ? "LONG" : "SHORT");
  const pnlPct = trade.invested > 0 ? (pnl / trade.invested) * 100 : 0;
  await prisma.trade.update({
    where: { id: trade.id },
    data: {
      status: "CLOSED", exitPrice: price, exitReason,
      pnl, pnlPct,
      closedAt: new Date(),
    },
  });
  await attachTradeOutcome(trade.id, pnlPct, exitReason);

  // consecutive-loss circuit breaker — N losing closes in a row means the
  // strategy is misreading the market; pause it instead of bleeding more
  if (pnlPct <= 0) {
    const recent = await prisma.trade.findMany({
      where: { liveStrategyId: live.id, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      take: LOSS_STREAK_LIMIT,
      select: { pnlPct: true },
    });
    if (recent.length === LOSS_STREAK_LIMIT && recent.every((t) => (t.pnlPct ?? 0) <= 0)) {
      await prisma.liveStrategy.update({
        where: { id: live.id }, data: { status: "PAUSED" },
      });
      await notify({
        userId: live.userId, type: "SL_HIT", severity: "ERROR",
        title: "قفل باخت‌های متوالی",
        body: `استراتژی روی ${live.symbol} پس از ${LOSS_STREAK_LIMIT} معامله‌ی زیان‌ده‌ی متوالی متوقف (PAUSED) شد. پوزیشن باز نمی‌ماند — برای ادامه دستی آن را از سر بگیرید.`,
      });
    }
  }

  // smart layer — fold this outcome into the strategy's learn state
  if (isSymbolicKind(version.kind) && smartEnabled(version.config)) {
    try {
      const cur = await prisma.liveStrategy.findUnique({ where: { id: live.id }, select: { stats: true } });
      const obj = parseJson<Record<string, unknown> & { pendingCtx?: (SmartDetail & { kind: string; tradeId?: string }) | null }>(
        cur?.stats ?? "{}", {},
      );
      const pending = obj.pendingCtx;
      if (pending && pending.kind === version.kind && (!pending.tradeId || pending.tradeId === trade.id)) {
        const learn = recordOutcome(
          version.kind as SymbolicKind, readLearn(cur?.stats ?? "{}"), pending, pnlPct,
        );
        await prisma.liveStrategy.update({
          where: { id: live.id },
          data: { stats: JSON.stringify({ ...obj, learn, pendingCtx: null }) },
        });
      } else if (pending) {
        // orphaned context (trade closed by stop-policy etc.) — drop it
        await prisma.liveStrategy.update({
          where: { id: live.id },
          data: { stats: JSON.stringify({ ...obj, pendingCtx: null }) },
        });
      }
    } catch {
      // learning must never break the trading loop
    }
  }
  await notify({
    userId: live.userId,
    type: exitReason === "TAKE_PROFIT" ? "TP_HIT" : exitReason === "STOP_LOSS" || exitReason === "LIQUIDATED" ? "SL_HIT" : "TRADE_CLOSED",
    severity: pnl >= 0 ? "SUCCESS" : "WARNING",
    title: exitReason === "LIQUIDATED" ? "پوزیشن لیکویید شد" : "معامله بسته شد",
    body: `${live.symbol} با دلیل ${exitReason} بسته شد. سود/زیان: ${pnl.toFixed(0)}`,
    metadata: { tradeId: trade.id, exitReason, pnl },
  });
}

async function executeStopPolicy(live: { id: string; userId: string; symbol: string; exchange: string; stopPolicy: string | null; mode: string }) {
  const paper = live.mode === "PAPER";
  // resting orders never outlive the strategy — market makers especially
  await cancelStrategyOrders(live.id, live.userId).catch(() => {});
  if (live.stopPolicy === "CLOSE_ALL") {
    const openTrades = await prisma.trade.findMany({
      where: { liveStrategyId: live.id, status: "OPEN" },
    });
    const adapter = paper
      ? publicAdapter(live.exchange || "NOBITEX")
      : await adapterForUser(live.userId, live.exchange || "NOBITEX", "stop-policy").catch(() => null);
    const price = adapter ? (await adapter.getTicker(live.symbol).catch(() => null))?.last ?? 0 : 0;
    for (const trade of openTrades) {
      const long = trade.side !== "SHORT";
      const futures = trade.leverage > 1;
      if (!paper) {
        let closedByPosition = false;
        if (futures && trade.exchangePositionId && adapter?.closePosition) {
          closedByPosition = await adapter.closePosition(trade.exchangePositionId).catch(() => false);
        }
        if (!closedByPosition) {
          await placeOrder(
            {
              userId: live.userId, liveStrategyId: live.id, tradeId: trade.id,
              symbol: live.symbol, side: long ? "SELL" : "BUY", type: "MARKET",
              amount: trade.amount,
              ...(futures ? { price: price || trade.entryPrice, futures: { leverage: trade.leverage, positionSide: long ? "LONG" : "SHORT" } } : {}),
            },
            `stopclose:${trade.id}`,
          );
        }
      }
      const exitPx = price || trade.entryPrice;
      const pnl = long
        ? trade.amount * (exitPx - trade.entryPrice)
        : trade.amount * (trade.entryPrice - exitPx);
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          status: "CLOSED", exitReason: "STOP_POLICY",
          exitPrice: exitPx, closedAt: new Date(),
          ...(paper ? { pnl, pnlPct: trade.invested > 0 ? (pnl / trade.invested) * 100 : 0 } : {}),
        },
      });
      await attachTradeOutcome(trade.id, trade.invested > 0 ? (pnl / trade.invested) * 100 : 0, "STOP_POLICY");
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
