import { publicAdapter } from "@/modules/exchanges/registry";
import { getCandles as readCachedCandles, tfMs } from "@/modules/pairs/service";
import { AppError } from "@/shared/errors";
import type { Candle } from "@/modules/exchanges/types";

/**
 * Signal factory data layer — candles come ONLY from the exchange's own
 * public API via the adapter. Freshness rule (hard): a series is stale when
 * its newest candle is older than 2× the timeframe; stale data must never
 * produce setups.
 */

/** ms between `now` and the newest candle's open time — null when empty. */
export function newestCandleAge(candles: { time: number }[], now = Date.now()): number | null {
  if (!candles.length) return null;
  return now - Math.max(...candles.map((c) => c.time));
}

export function isStale(candles: { time: number }[], timeframe: string, now = Date.now()): boolean {
  const age = newestCandleAge(candles, now);
  return age === null || age > 2 * tfMs(timeframe);
}

/** Throws STALE_DATA when the series fails the freshness gate. */
export function assertFresh(candles: { time: number }[], timeframe: string, now = Date.now()): void {
  if (isStale(candles, timeframe, now)) {
    throw new AppError("STALE_DATA", 400, { timeframe, age: newestCandleAge(candles, now) });
  }
}

/** Fresh candles straight from the exchange public API. */
export async function getCandles(
  exchange: string,
  symbol: string,
  timeframe: string,
  limit = 300,
): Promise<Candle[]> {
  const candles = await publicAdapter(exchange).getCandles(symbol, timeframe, undefined, limit);
  assertFresh(candles, timeframe);
  return candles;
}

/**
 * Read-through cache — delegates to the pairs service, which already routes
 * per exchange via publicAdapter and writes misses into HistoricalCandle.
 * Freshness gate applies after the read.
 */
export async function getCandlesCached(opts: {
  symbol: string;
  timeframe: string;
  start: Date;
  end: Date;
  exchange?: string;
}): Promise<Candle[]> {
  const candles = await readCachedCandles(opts);
  assertFresh(candles, opts.timeframe);
  return candles;
}

// ---------------------------------------------------------------------------
// Freshness flag — set by the data-freshness-watchdog, read by every stage
// that would produce setups. Stale/absent data ⇒ production must be skipped.
// ---------------------------------------------------------------------------

const freshness = new Map<string, { ok: boolean; at: number }>();

export function markDataFresh(exchange: string, ok: boolean): void {
  freshness.set(exchange.toUpperCase(), { ok, at: Date.now() });
}

/** All watched exchanges fresh (or a specific one). Unknown ⇒ fresh (optimistic until first watchdog run). */
export function dataFresh(exchange?: string): boolean {
  if (!exchange) return [...freshness.values()].every((v) => v.ok);
  return freshness.get(exchange.toUpperCase())?.ok ?? true;
}

export function dataFreshCheckedAt(exchange: string): number | null {
  return freshness.get(exchange.toUpperCase())?.at ?? null;
}
