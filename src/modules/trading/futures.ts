import { clamp, parseJson } from "@/shared/utils";

/**
 * Futures (margin) helpers — market type + leverage live inside
 * `StrategyVersion.config` JSON so no column is needed there.
 *
 * Model: isolated margin — a trade posts `invested` margin and controls
 * `invested * leverage` notional. Liquidation fires when adverse price
 * move wipes the margin (minus a maintenance buffer).
 */

export type MarketKind = "SPOT" | "FUTURES";

export interface MarketConfig {
  market: MarketKind;
  /** leverage multiplier — 1..10, steps of 0.5 (Nobitex margin rules) */
  leverage: number;
  /** exchange id — NOBITEX | KUCOIN | … (default NOBITEX for legacy configs) */
  exchange: string;
}

export const MAX_LEVERAGE = 10;
/** fraction of the theoretical liq distance kept as maintenance buffer */
const MAINTENANCE_BUFFER = 0.9;

export function readMarketConfig(configJson: string): MarketConfig {
  const c = parseJson<{ market?: string; leverage?: number; exchange?: string }>(configJson, {});
  const market: MarketKind = c.market === "FUTURES" ? "FUTURES" : "SPOT";
  // Nobitex margin leverage moves in 0.5 increments
  const raw = clamp(c.leverage ?? (market === "FUTURES" ? 3 : 1), 1, MAX_LEVERAGE);
  const leverage = Math.round(raw * 2) / 2;
  return { market, leverage, exchange: (c.exchange ?? "NOBITEX").toUpperCase() };
}

/** Exchange id embedded in a strategy version config (NOBITEX when absent). */
export function readExchange(configJson: string): string {
  return readMarketConfig(configJson).exchange;
}

export function isFutures(configJson: string): boolean {
  return readMarketConfig(configJson).market === "FUTURES";
}

/**
 * Approximate liquidation price (isolated margin).
 * Long loses everything when price drops ≈ entry/leverage (minus buffer);
 * short symmetrically above entry.
 */
export function liquidationPrice(
  entry: number,
  side: "LONG" | "SHORT",
  leverage: number,
): number {
  const dist = (entry / Math.max(leverage, 1)) * MAINTENANCE_BUFFER;
  return side === "LONG" ? entry - dist : entry + dist;
}

/** Unrealized PnL of a futures position at `price` (margin excluded). */
export function futuresPnl(
  entry: number,
  price: number,
  amount: number,
  side: "LONG" | "SHORT",
): number {
  return side === "LONG" ? (price - entry) * amount : (entry - price) * amount;
}

export type PositionSide = "LONG" | "SHORT";
