import { prisma } from "@/infrastructure/database/prisma";
import { placeOrder, cancelOrder } from "./order-engine";
import { diffQuotes, midPrice, cancelStrategyOrders, type DesiredQuote, type PaperQuote, type PaperMmState, simulatePaperFills } from "./market-making";
import { atr } from "@/modules/indicators/engine";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { logger } from "@/infrastructure/logging/logger";
import { parseJson } from "@/shared/utils";
import type { ExchangeAdapter } from "@/modules/exchanges/types";
import type { GridConfigInput } from "@/modules/strategies/service";

/**
 * Smart Grid — rests a fixed ladder of LIMIT orders around an anchor price:
 * buys below, sells above. Each cycle (buy fill → sell fill one level up)
 * earns (step − round-trip fee). "Smart": the step adapts to volatility —
 * spacing = max(cfgStepPct, atrPct × atrStepMult) — so the grid widens in
 * wild markets (fewer, richer cycles) and tightens in calm ones.
 *
 * The anchor recenters when mid drifts beyond recenterPct — the whole ladder
 * is cancelled and rebuilt so the grid never strays far from price.
 * Spot only — shorts need futures (rejected at validation).
 */

export interface GridConfig {
  rangePct: number;      // half-band around anchor (default 4)
  levels: number;        // rungs per side (default 5)
  stepPct: number;       // minimum spacing between rungs (default 0.8)
  atrStepMult: number;   // step ≥ ATR% × this (default 1.2 — smart spacing)
  orderSizePct: number;  // % of allocated capital per rung (default 15)
  recenterPct: number;   // anchor drift triggering rebuild (default = rangePct)
  requotePct: number;    // match tolerance for existing orders (default 0.1)
  maxInventoryPct: number; // stop buying above this base share (default 80)
}

export function readGridConfig(configJson: string): GridConfig {
  const g = parseJson<{ grid?: GridConfigInput }>(configJson, {}).grid ?? {};
  const rangePct = g.rangePct ?? 4;
  return {
    rangePct,
    levels: Math.floor(g.levels ?? 5),
    stepPct: g.stepPct ?? 0.8,
    atrStepMult: g.atrStepMult ?? 1.2,
    orderSizePct: g.orderSizePct ?? 15,
    recenterPct: g.recenterPct ?? rangePct,
    requotePct: g.requotePct ?? 0.1,
    maxInventoryPct: g.maxInventoryPct ?? 80,
  };
}

/** Effective rung spacing — config floor vs ATR-scaled step, whichever wider. */
export function gridStepPct(cfg: GridConfig, atrPct: number | null): number {
  return Math.max(cfg.stepPct, (atrPct ?? 0) * cfg.atrStepMult);
}

/** Grid level prices — buys under anchor, sells over. */
export function gridLevels(anchor: number, stepPct: number, levels: number, rangePct: number, pricePrecision: number) {
  const out: { buy: number[]; sell: number[] } = { buy: [], sell: [] };
  const band = rangePct / 100;
  const f = 10 ** pricePrecision;
  for (let i = 1; i <= levels; i++) {
    const off = Math.min((stepPct * i) / 100, band);
    out.buy.push(Math.round(anchor * (1 - off) * f) / f);
    out.sell.push(Math.round(anchor * (1 + off) * f) / f);
  }
  return out;
}

/** Desired resting orders for this tick — buys funded by free quote, sells by inventory. */
export function planGrid(opts: {
  anchor: number;
  stepPct: number;
  cfg: GridConfig;
  allocatedCapital: number;
  quoteFree: number;
  baseFree: number;
  baseTotal: number;
  mid: number;
  pricePrecision: number;
  amountPrecision: number;
  minAmount?: number | null;
}): DesiredQuote[] {
  const { anchor, stepPct, cfg, allocatedCapital, pricePrecision, amountPrecision, minAmount, mid } = opts;
  if (!Number.isFinite(anchor) || anchor <= 0) return [];

  const inventoryPct = (opts.baseTotal * mid) / allocatedCapital * 100;
  const canBuy = inventoryPct < cfg.maxInventoryPct;
  const notional = allocatedCapital * (cfg.orderSizePct / 100);
  const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

  const out: DesiredQuote[] = [];
  let quoteFree = opts.quoteFree;
  let baseFree = opts.baseFree;
  const lv = gridLevels(anchor, stepPct, cfg.levels, cfg.rangePct, pricePrecision);

  if (canBuy) {
    for (const price of lv.buy) {
      const amount = round(Math.min(notional, quoteFree) / price, amountPrecision);
      if (amount > 0 && (!minAmount || amount >= minAmount)) {
        out.push({ side: "BUY", price, amount });
        quoteFree -= amount * price;
      }
    }
  }
  // sell rungs sized from available base, split evenly across levels
  const sellable = baseFree;
  if (sellable > 0) {
    const per = round(sellable / cfg.levels, amountPrecision);
    for (const price of lv.sell) {
      const amount = Math.min(per, baseFree);
      if (amount > 0 && (!minAmount || amount >= minAmount)) {
        out.push({ side: "SELL", price, amount });
        baseFree -= amount;
      }
    }
  }
  return out;
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
  version: { config: string; timeframe: string };
};

async function atrPctFor(live: LiveLike): Promise<number | null> {
  const candles = await getCandles({
    symbol: live.symbol,
    timeframe: live.version.timeframe,
    start: new Date(Date.now() - 60 * tfMs(live.version.timeframe)),
    end: new Date(),
    exchange: live.exchange,
  }).catch(() => []);
  if (candles.length < 20) return null;
  const a = atr(candles, 14);
  const v = a[a.length - 1];
  const last = candles[candles.length - 1]?.close;
  return Number.isFinite(v) && last ? (v / last) * 100 : null;
}

/** One grid tick — mirror of marketMakingTick but anchored ladder. */
export async function gridTick(live: LiveLike, adapter: ExchangeAdapter): Promise<void> {
  if (live.status === "PAUSED") {
    await cancelStrategyOrders(live.id, live.userId);
    return;
  }

  const book = await adapter.getOrderBook(live.symbol);
  const mid = midPrice(book);
  if (!mid) {
    logger.warn("grid: empty order book", { module: "trading", liveStrategyId: live.id });
    return;
  }

  const cfg = readGridConfig(live.version.config);
  const prev = parseJson<{ gridAnchor?: number }>(live.stats, {});
  let anchor = prev.gridAnchor ?? mid;

  // drifted out of band → rebuild the ladder around price
  const driftPct = (Math.abs(mid - anchor) / anchor) * 100;
  let forceRebuild = false;
  if (driftPct >= cfg.recenterPct) {
    anchor = mid;
    forceRebuild = true;
  }

  const stepPct = gridStepPct(cfg, await atrPctFor(live));
  const pair = await prisma.pair.findUnique({
    where: { exchange_symbol: { exchange: live.exchange || "NOBITEX", symbol: live.symbol } },
  });

  // sync open orders with the exchange (fills / external cancels)
  const openOrders = await prisma.order.findMany({
    where: { liveStrategyId: live.id, status: { in: [...OPEN_STATUSES] } },
  });
  const exchangeOpen = await adapter.getOpenOrders(live.symbol).catch(() => null);
  const gone = new Set<string>();
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

  const balances = await adapter.getBalance().catch(() => []);
  const quoteCur = /IRT$/.test(live.symbol) ? "IRT" : "USDT";
  const baseCur = live.symbol.replace(/IRT$|USDT$|-/g, "");
  const quoteBal = balances.find((b) => b.currency === quoteCur);
  const baseBal = balances.find((b) => b.currency === baseCur);

  const desired = planGrid({
    anchor, stepPct, cfg,
    allocatedCapital: live.allocatedCapital,
    quoteFree: quoteBal?.free ?? 0,
    baseFree: baseBal?.free ?? 0,
    baseTotal: baseBal?.total ?? 0,
    mid,
    pricePrecision: pair?.pricePrecision ?? (quoteCur === "IRT" ? 0 : 2),
    amountPrecision: pair?.amountPrecision ?? 8,
    minAmount: pair?.minAmount,
  });

  // re-center cancels EVERYTHING — tolerance matching would keep stale rungs
  const diff = forceRebuild
    ? { keep: [] as string[], cancels: active, placements: desired }
    : diffQuotes(active, desired, cfg.requotePct);

  for (const o of diff.cancels) {
    await cancelOrder(o.id, live.userId).catch((e) =>
      logger.warn("grid cancel failed", { module: "trading", orderId: o.id, errorCode: String(e) }));
  }
  for (const [i, q] of diff.placements.entries()) {
    await placeOrder(
      {
        userId: live.userId, liveStrategyId: live.id,
        symbol: live.symbol, side: q.side, type: "LIMIT",
        amount: q.amount, price: q.price,
      },
      `grid:${live.id}:${q.side}:${q.price}:${i}:${Date.now()}`,
    );
  }

  const inventoryPct = ((baseBal?.total ?? 0) * mid) / live.allocatedCapital * 100;
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: {
      lastSignalAt: new Date(),
      stats: JSON.stringify({
        kind: "GRID", mid, gridAnchor: anchor, stepPct: Math.round(stepPct * 100) / 100,
        openRungs: diff.keep.length + diff.placements.length,
        bids: desired.filter((q) => q.side === "BUY").length,
        asks: desired.filter((q) => q.side === "SELL").length,
        inventoryPct: Math.round(inventoryPct * 100) / 100,
      }),
    },
  });
}

// ---- Paper -----------------------------------------------------------------

export async function paperGridTick(live: LiveLike, adapter: ExchangeAdapter): Promise<void> {
  const prev = parseJson<{ paper?: PaperMmState; gridAnchor?: number }>(live.stats, {});
  const state: PaperMmState = prev.paper ?? {
    cash: live.allocatedCapital, base: 0, nextId: 1, quotes: [], fills: 0,
  };

  const book = await adapter.getOrderBook(live.symbol);
  const mid = midPrice(book);
  if (!mid) {
    logger.warn("paper grid: empty order book", { module: "trading", liveStrategyId: live.id });
    return;
  }

  const cfg = readGridConfig(live.version.config);
  let anchor = prev.gridAnchor ?? mid;
  let rebuild = false;
  if (live.status === "PAUSED") state.quotes = [];

  if (live.status !== "PAUSED") {
    if ((Math.abs(mid - anchor) / anchor) * 100 >= cfg.recenterPct) {
      anchor = mid;
      state.quotes = []; // rebuild from scratch
      rebuild = true;
    }
    const stepPct = gridStepPct(cfg, await atrPctFor(live));
    const bestBid = book.bids[0]?.[0] ?? mid;
    const bestAsk = book.asks[0]?.[0] ?? mid;

    const { filled, open } = simulatePaperFills(state.quotes, bestBid, bestAsk);
    for (const q of filled) {
      if (q.side === "BUY" && state.cash >= q.price * q.amount) {
        state.cash -= q.price * q.amount; state.base += q.amount; state.fills++;
      } else if (q.side === "SELL" && state.base >= q.amount) {
        state.cash += q.price * q.amount; state.base -= q.amount; state.fills++;
      } else { open.push(q); continue; }
      state.fillsLog = [...(state.fillsLog ?? []), { t: Date.now(), side: q.side, price: q.price }].slice(-100);
    }
    state.quotes = open;

    const pair = await prisma.pair.findUnique({
      where: { exchange_symbol: { exchange: live.exchange || "NOBITEX", symbol: live.symbol } },
    });
    const quoteCur = /IRT$/.test(live.symbol) ? "IRT" : "USDT";
    const desired = planGrid({
      anchor, stepPct, cfg,
      allocatedCapital: live.allocatedCapital,
      quoteFree: state.cash,
      baseFree: state.base,
      baseTotal: state.base,
      mid,
      pricePrecision: pair?.pricePrecision ?? (quoteCur === "IRT" ? 0 : 2),
      amountPrecision: pair?.amountPrecision ?? 8,
      minAmount: pair?.minAmount,
    });
    const diff = rebuild
      ? { keep: [] as string[], cancels: [], placements: desired }
      : diffQuotes(state.quotes.map((q) => ({ id: String(q.id), side: q.side, price: q.price })), desired, cfg.requotePct);
    const kept = new Set(diff.keep);
    state.quotes = state.quotes.filter((q) => kept.has(String(q.id)));
    for (const q of diff.placements) state.quotes.push({ id: state.nextId++, ...q });
  }

  const equity = state.cash + state.base * mid;
  state.pnlHist = [...(state.pnlHist ?? []), { t: Date.now(), v: equity - live.allocatedCapital }].slice(-200);
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: {
      lastSignalAt: new Date(),
      stats: JSON.stringify({
        kind: "GRID", mid, gridAnchor: anchor,
        openRungs: state.quotes.length,
        bids: state.quotes.filter((q: PaperQuote) => q.side === "BUY").length,
        asks: state.quotes.filter((q: PaperQuote) => q.side === "SELL").length,
        equity: Math.round(equity * 100) / 100,
        pnl: Math.round((equity - live.allocatedCapital) * 100) / 100,
        fills: state.fills,
        paper: state,
      }),
    },
  });
}
