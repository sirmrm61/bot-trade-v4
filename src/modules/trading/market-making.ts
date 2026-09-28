import { prisma } from "@/infrastructure/database/prisma";
import { placeOrder, cancelOrder } from "./order-engine";
import { logger } from "@/infrastructure/logging/logger";
import { parseJson } from "@/shared/utils";
import type { ExchangeAdapter, OrderBook } from "@/modules/exchanges/types";
import type { MarketMakingConfigInput } from "@/modules/strategies/service";

/**
 * Market Making — quotes bid and ask LIMIT orders around mid price each
 * tick, earning the spread. Orders are re-quoted when mid drifts beyond
 * requotePct. Inventory is capped by maxInventoryPct: once base holdings
 * exceed that share of allocated capital, bid quotes stop.
 *
 * Orders flow through the Order Engine (placeOrder/cancelOrder) — this
 * module never talks to the exchange directly for writes. The risk
 * engine's single-open-order rule does not apply here; market making
 * intentionally keeps multiple quotes open, so sizing is gated on live
 * balances instead.
 */

export interface MmConfig {
  spreadPct: number;
  orderSizePct: number;
  levels: number;
  levelStepPct: number;
  requotePct: number;
  maxInventoryPct: number;
}

export function readMmConfig(configJson: string): MmConfig {
  const cfg = parseJson<{ marketMaking?: MarketMakingConfigInput }>(configJson, {});
  const mm = cfg.marketMaking ?? {};
  const spreadPct = mm.spreadPct ?? 0.6;
  return {
    spreadPct,
    orderSizePct: mm.orderSizePct ?? 10,
    levels: Math.floor(mm.levels ?? 1),
    levelStepPct: mm.levelStepPct ?? spreadPct,
    requotePct: mm.requotePct ?? 0.1,
    maxInventoryPct: mm.maxInventoryPct ?? 60,
  };
}

const roundTo = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

export interface DesiredQuote {
  side: "BUY" | "SELL";
  price: number;
  amount: number;
}

/** Pure quote planner — computes desired open quotes for this tick. */
export function planQuotes(opts: {
  mid: number;
  cfg: MmConfig;
  allocatedCapital: number;
  quoteFree: number;
  baseFree: number;
  baseTotal: number;
  pricePrecision: number;
  amountPrecision: number;
  minAmount?: number | null;
}): DesiredQuote[] {
  const { mid, cfg, allocatedCapital, pricePrecision, amountPrecision, minAmount } = opts;
  if (!Number.isFinite(mid) || mid <= 0) return [];

  const inventoryPct = (opts.baseTotal * mid) / allocatedCapital * 100;
  const canBuy = inventoryPct < cfg.maxInventoryPct;
  const canSell = opts.baseFree > 0;
  const notionalPerQuote = allocatedCapital * (cfg.orderSizePct / 100);

  const out: DesiredQuote[] = [];
  let quoteFree = opts.quoteFree;
  let baseFree = opts.baseFree;

  for (let l = 0; l < cfg.levels; l++) {
    const offset = (cfg.spreadPct / 2 + l * cfg.levelStepPct) / 100;
    const bidPrice = roundTo(mid * (1 - offset), pricePrecision);
    const askPrice = roundTo(mid * (1 + offset), pricePrecision);

    if (canBuy && bidPrice > 0) {
      const amount = roundTo(Math.min(notionalPerQuote, quoteFree) / bidPrice, amountPrecision);
      if (amount > 0 && (!minAmount || amount >= minAmount)) {
        out.push({ side: "BUY", price: bidPrice, amount });
        quoteFree -= amount * bidPrice;
      }
    }
    if (canSell && askPrice > 0) {
      const amount = roundTo(Math.min(notionalPerQuote / askPrice, baseFree), amountPrecision);
      if (amount > 0 && (!minAmount || amount >= minAmount)) {
        out.push({ side: "SELL", price: askPrice, amount });
        baseFree -= amount;
      }
    }
  }
  return out;
}

interface OpenOrderLike {
  id: string;
  side: string;
  price: number | null;
}

/**
 * Match open orders to desired quotes by side + price proximity
 * (within requotePct). Unmatched desired → placements; unmatched open → cancels.
 */
export function diffQuotes(
  open: OpenOrderLike[],
  desired: DesiredQuote[],
  requotePct: number,
): { keep: string[]; cancels: OpenOrderLike[]; placements: DesiredQuote[] } {
  const pool = open.filter((o) => o.price !== null && o.price > 0);
  const used = new Set<string>();
  const keep: string[] = [];
  const placements: DesiredQuote[] = [];

  for (const q of desired) {
    const tol = (requotePct / 100) * q.price;
    const match = pool.find(
      (o) => !used.has(o.id) && o.side === q.side && Math.abs(o.price! - q.price) <= tol,
    );
    if (match) {
      used.add(match.id);
      keep.push(match.id);
    } else {
      placements.push(q);
    }
  }
  return { keep, cancels: pool.filter((o) => !used.has(o.id)), placements };
}

const OPEN_STATUSES = ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] as const;

type LiveLike = {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  allocatedCapital: number;
  status: string;
  stats: string;
  version: { config: string };
};

/** One market-making tick — called from liveTick for MARKET_MAKING strategies. */
export async function marketMakingTick(live: LiveLike, adapter: ExchangeAdapter): Promise<void> {
  // PAUSED → pull all quotes (an unmanaged resting quote is adverse-selection bait)
  if (live.status === "PAUSED") {
    await cancelStrategyOrders(live.id, live.userId);
    return;
  }

  const book = await adapter.getOrderBook(live.symbol);
  const mid = midPrice(book);
  if (!mid) {
    logger.warn("market making: empty order book", { module: "trading", liveStrategyId: live.id });
    return;
  }

  const pair = await prisma.pair.findUnique({
    where: { exchange_symbol: { exchange: live.exchange || "NOBITEX", symbol: live.symbol } },
  });
  const cfg = readMmConfig(live.version.config);

  // sync internal open orders with the exchange (fills / external cancels)
  const openOrders = await prisma.order.findMany({
    where: { liveStrategyId: live.id, status: { in: [...OPEN_STATUSES] } },
  });
  const exchangeOpen = await adapter.getOpenOrders(live.symbol).catch(() => null);
  const gone = new Set<string>();
  // PENDING rows that never reached the exchange would keep "matching" desired
  // quotes forever — expire them after 60s so a fresh quote can be placed
  for (const o of openOrders) {
    if (!o.exchangeOrderId && o.status === "PENDING" && Date.now() - o.createdAt.getTime() > 60_000) {
      await prisma.order.update({ where: { id: o.id }, data: { status: "EXPIRED", closedAt: new Date() } });
      gone.add(o.id);
    }
  }
  if (exchangeOpen) {
    const liveIds = new Set(exchangeOpen.map((o) => o.id));
    for (const o of openOrders) {
      if (gone.has(o.id) || !o.exchangeOrderId || liveIds.has(o.exchangeOrderId)) continue;
      const real = await adapter.getOrder(o.exchangeOrderId, live.symbol).catch(() => null);
      if (!real || real.status === "open" || real.status === "partially_filled") continue;
      await prisma.order.update({
        where: { id: o.id },
        data: {
          status: real.status === "filled" ? "FILLED" : real.status === "cancelled" ? "CANCELLED" : "REJECTED",
          filledAmount: real.filledAmount,
          avgFillPrice: real.avgPrice,
          closedAt: new Date(),
        },
      });
      gone.add(o.id);
    }
  }
  const active = openOrders.filter((o) => !gone.has(o.id));

  // balances → inventory + free capital per side
  const balances = await adapter.getBalance().catch(() => []);
  const quoteCur = /IRT$/.test(live.symbol) ? "IRT" : "USDT";
  const baseCur = live.symbol.replace(/IRT$|USDT$/, "");
  const quoteBal = balances.find((b) => b.currency === quoteCur);
  const baseBal = balances.find((b) => b.currency === baseCur);

  const desired = planQuotes({
    mid,
    cfg,
    allocatedCapital: live.allocatedCapital,
    quoteFree: quoteBal?.free ?? 0,
    baseFree: baseBal?.free ?? 0,
    baseTotal: baseBal?.total ?? 0,
    pricePrecision: pair?.pricePrecision ?? (quoteCur === "IRT" ? 0 : 2),
    amountPrecision: pair?.amountPrecision ?? 8,
    minAmount: pair?.minAmount,
  });

  const diff = diffQuotes(active, desired, cfg.requotePct);

  for (const o of diff.cancels) {
    await cancelOrder(o.id, live.userId).catch((e) =>
      logger.warn("mm cancel failed", { module: "trading", orderId: o.id, errorCode: String(e) }),
    );
  }
  for (const [i, q] of diff.placements.entries()) {
    await placeOrder(
      {
        userId: live.userId,
        liveStrategyId: live.id,
        symbol: live.symbol,
        side: q.side,
        type: "LIMIT",
        amount: q.amount,
        price: q.price,
      },
      `mm:${live.id}:${q.side}:${q.price}:${i}:${Date.now()}`,
    );
  }

  const inventoryPct = ((baseBal?.total ?? 0) * mid) / live.allocatedCapital * 100;
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: {
      lastSignalAt: new Date(),
      stats: JSON.stringify({
        kind: "MARKET_MAKING",
        mid,
        spreadPct: cfg.spreadPct,
        openQuotes: diff.keep.length + diff.placements.length,
        bids: desired.filter((q) => q.side === "BUY").length,
        asks: desired.filter((q) => q.side === "SELL").length,
        inventoryPct: Math.round(inventoryPct * 100) / 100,
      }),
    },
  });
}

// ---- Paper (تست زنده) -----------------------------------------------------
//
// Simulated market making against the live public order book. No orders are
// sent to the exchange — paper quotes and balances live in live.stats.
// Fill model: a resting bid fills when best ask drops to it (a seller crossed
// the spread into our bid); symmetric for asks.

export interface PaperQuote {
  id: number;
  side: "BUY" | "SELL";
  price: number;
  amount: number;
}

export interface PaperFill {
  t: number;
  side: "BUY" | "SELL";
  price: number;
}

export interface PaperMmState {
  cash: number;   // quote currency
  base: number;   // base units held
  nextId: number;
  quotes: PaperQuote[];
  fills: number;
  /** recent fill events — used to draw markers on the live chart */
  fillsLog?: PaperFill[];
  /** equity curve samples — {t, paper PnL} */
  pnlHist?: { t: number; v: number }[];
}

/** Pure fill pass — returns updated quotes + mutated cash/base/fills. */
export function simulatePaperFills(
  quotes: PaperQuote[],
  bestBid: number,
  bestAsk: number,
): { filled: PaperQuote[]; open: PaperQuote[] } {
  const filled: PaperQuote[] = [];
  const open: PaperQuote[] = [];
  for (const q of quotes) {
    if ((q.side === "BUY" && bestAsk <= q.price) || (q.side === "SELL" && bestBid >= q.price)) {
      filled.push(q);
    } else {
      open.push(q);
    }
  }
  return { filled, open };
}

export async function paperMarketMakingTick(live: LiveLike, adapter: ExchangeAdapter): Promise<void> {
  const prev = parseJson<{ paper?: PaperMmState }>(live.stats, {});
  const state: PaperMmState = prev.paper ?? {
    cash: live.allocatedCapital, base: 0, nextId: 1, quotes: [], fills: 0,
  };

  const book = await adapter.getOrderBook(live.symbol);
  const mid = midPrice(book);
  if (!mid) {
    logger.warn("paper mm: empty order book", { module: "trading", liveStrategyId: live.id });
    return;
  }

  // PAUSED → pull all paper quotes
  if (live.status === "PAUSED") state.quotes = [];

  if (live.status !== "PAUSED") {
    const bestBid = book.bids[0]?.[0] ?? mid;
    const bestAsk = book.asks[0]?.[0] ?? mid;

    const { filled, open } = simulatePaperFills(state.quotes, bestBid, bestAsk);
    for (const q of filled) {
      if (q.side === "BUY" && state.cash >= q.price * q.amount) {
        state.cash -= q.price * q.amount; state.base += q.amount; state.fills++;
      } else if (q.side === "SELL" && state.base >= q.amount) {
        state.cash += q.price * q.amount; state.base -= q.amount; state.fills++;
      } else {
        open.push(q); // would have filled but paper balance can't cover — keep resting
        continue;
      }
      state.fillsLog = [...(state.fillsLog ?? []), { t: Date.now(), side: q.side, price: q.price }].slice(-100);
    }
    state.quotes = open;

    const pair = await prisma.pair.findUnique({
      where: { exchange_symbol: { exchange: live.exchange || "NOBITEX", symbol: live.symbol } },
    });
    const quoteCur = /IRT$/.test(live.symbol) ? "IRT" : "USDT";
    const cfg = readMmConfig(live.version.config);
    const desired = planQuotes({
      mid,
      cfg,
      allocatedCapital: live.allocatedCapital,
      quoteFree: state.cash,
      baseFree: state.base,
      baseTotal: state.base,
      pricePrecision: pair?.pricePrecision ?? (quoteCur === "IRT" ? 0 : 2),
      amountPrecision: pair?.amountPrecision ?? 8,
      minAmount: pair?.minAmount,
    });
    const diff = diffQuotes(
      state.quotes.map((q) => ({ id: String(q.id), side: q.side, price: q.price })),
      desired,
      cfg.requotePct,
    );
    const kept = new Set(diff.keep);
    state.quotes = state.quotes.filter((q) => kept.has(String(q.id)));
    for (const q of diff.placements) {
      state.quotes.push({ id: state.nextId++, side: q.side, price: q.price, amount: q.amount });
    }
  }

  const equity = state.cash + state.base * mid;
  const inventoryPct = (state.base * mid) / live.allocatedCapital * 100;
  state.pnlHist = [...(state.pnlHist ?? []), { t: Date.now(), v: equity - live.allocatedCapital }].slice(-200);
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: {
      lastSignalAt: new Date(),
      stats: JSON.stringify({
        kind: "MARKET_MAKING",
        mid,
        openQuotes: state.quotes.length,
        bids: state.quotes.filter((q) => q.side === "BUY").length,
        asks: state.quotes.filter((q) => q.side === "SELL").length,
        inventoryPct: Math.round(inventoryPct * 100) / 100,
        equity: Math.round(equity * 100) / 100,
        pnl: Math.round((equity - live.allocatedCapital) * 100) / 100,
        fills: state.fills,
        paper: state,
      }),
    },
  });
}

/** Cancel every open order of a live strategy (used by PAUSE and STOP paths). */
export async function cancelStrategyOrders(liveStrategyId: string, userId: string): Promise<number> {
  const open = await prisma.order.findMany({
    where: { liveStrategyId, status: { in: [...OPEN_STATUSES] } },
    select: { id: true },
  });
  let cancelled = 0;
  for (const o of open) {
    await cancelOrder(o.id, userId)
      .then(() => cancelled++)
      .catch((e) => logger.warn("order cancel failed", { module: "trading", orderId: o.id, errorCode: String(e) }));
  }
  return cancelled;
}

export function midPrice(book: OrderBook): number | null {
  const bid = book.bids[0]?.[0];
  const ask = book.asks[0]?.[0];
  if (!bid && !ask) return null;
  if (!bid || !ask) return bid ?? ask ?? null;
  return (bid + ask) / 2;
}
