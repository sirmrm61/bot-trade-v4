import type { Candle, OrderBook } from "@/modules/exchanges/types";

/** Pure metric helpers — no I/O, fully unit-testable. */

export function midPrice(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return (bid + ask) / 2;
}

/** (ask − bid)/mid × 100 — null when quotes are missing/crossed. */
export function spreadPct(bid: number, ask: number): number | null {
  const mid = midPrice(bid, ask);
  return mid === null ? null : ((ask - bid) / mid) * 100;
}

/** Quote-currency depth sitting within ±bandPct of mid (both sides summed). */
export function bookDepthQuote(book: OrderBook, mid: number, bandPct: number): number {
  const lo = mid * (1 - bandPct / 100);
  const hi = mid * (1 + bandPct / 100);
  let depth = 0;
  for (const [p, a] of book.bids) if (p >= lo) depth += p * a;
  for (const [p, a] of book.asks) if (p <= hi) depth += p * a;
  return depth;
}

export interface WalkResult {
  avgPrice: number | null;
  filledQuote: number;      // how much of the notional got filled
  fullyFilled: boolean;
  slippagePct: number | null; // |avgPrice − mid| / mid × 100, null when nothing fills
}

/**
 * Walk the book for a hypothetical MARKET order of `notionalQuote` (quote ccy).
 * side "buy" consumes asks, "sell" consumes bids.
 */
export function walkBook(book: OrderBook, side: "buy" | "sell", notionalQuote: number, mid: number): WalkResult {
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = notionalQuote;
  let paid = 0;
  let filled = 0; // base amount
  for (const [price, amount] of levels) {
    if (!(price > 0) || !(amount > 0)) continue;
    const levelQuote = price * amount;
    const take = Math.min(levelQuote, remaining);
    paid += take;
    filled += take / price;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (filled <= 0) return { avgPrice: null, filledQuote: 0, fullyFilled: false, slippagePct: null };
  const avgPrice = paid / filled;
  return {
    avgPrice,
    filledQuote: paid,
    fullyFilled: remaining <= 0,
    slippagePct: (Math.abs(avgPrice - mid) / mid) * 100,
  };
}

/** Std-dev of per-candle log returns, in %. Null when <2 usable candles. */
export function realizedVolPct(candles: Candle[]): number | null {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  if (closes.length < 2) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * 100;
}

/** (high24h − low24h)/mid × 100 — coarse volatility proxy when candles are unavailable. */
export function dayRangePct(high24h: number, low24h: number, mid: number): number | null {
  if (!(mid > 0) || !(high24h >= low24h) || !(low24h >= 0)) return null;
  return ((high24h - low24h) / mid) * 100;
}
