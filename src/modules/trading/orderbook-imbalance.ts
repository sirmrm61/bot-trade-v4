import type { OrderBook } from "@/modules/exchanges/types";
import { clamp, parseJson } from "@/shared/utils";
import { ema } from "@/modules/indicators/engine";
import type { ObiConfigInput } from "@/modules/strategies/service";

/**
 * Order Book Imbalance — measures bid vs ask depth pressure.
 * Score ∈ [-1, +1]: +1 = book is all bids (buy pressure), -1 = all asks.
 * Computed from live order-book snapshots each tick. Backtests use a
 * candle proxy (close position within the range) — see the bottom of
 * this file.
 */

export interface ObiConfig {
  depthLevels: number;
  emaPeriod: number;
}

export function readObiConfig(configJson: string): ObiConfig {
  const cfg = parseJson<{ orderBookImbalance?: ObiConfigInput }>(configJson, {});
  return {
    depthLevels: clamp(Math.floor(cfg.orderBookImbalance?.depthLevels ?? 10), 1, 50),
    emaPeriod: clamp(Math.floor(cfg.orderBookImbalance?.emaPeriod ?? 1), 1, 200),
  };
}

/** (ΣbidVol − ΣaskVol) / (ΣbidVol + ΣaskVol) over the top `depthLevels` book levels. */
export function orderBookImbalance(book: OrderBook, depthLevels = 10): number {
  const bidVol = book.bids.slice(0, depthLevels).reduce((a, [, v]) => a + v, 0);
  const askVol = book.asks.slice(0, depthLevels).reduce((a, [, v]) => a + v, 0);
  const total = bidVol + askVol;
  return total > 0 ? (bidVol - askVol) / total : 0;
}

/** EMA smoothing across ticks — state is persisted in live.stats. */
export function smoothObi(raw: number, prevEma: number | undefined, emaPeriod: number): number {
  if (emaPeriod <= 1 || prevEma === undefined || !Number.isFinite(prevEma)) return raw;
  const alpha = 2 / (emaPeriod + 1);
  return raw * alpha + prevEma * (1 - alpha);
}

// ---- Backtest proxy ------------------------------------------------------
//
// Historical order books don't exist, so the backtest approximates depth
// imbalance with the candle's close position within its range:
//   close at the high → +1 (buyers dominated), at the low → -1.

/** ∈ [-1, +1] — where the close landed inside [low, high]. */
export function candleImbalanceProxy(c: { high: number; low: number; close: number }): number {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return ((c.close - c.low) - (c.high - c.close)) / range;
}

/** EMA-smoothed proxy series over the full candle set (NaN during warmup). */
export function obiProxySeries(
  candles: { high: number; low: number; close: number }[],
  configJson: string,
): number[] {
  const cfg = readObiConfig(configJson);
  return ema(candles.map(candleImbalanceProxy), cfg.emaPeriod);
}

/** Signal source for runBacktest — proxy EMA vs the version's thresholds. */
export function obiBacktestSignal(
  candles: { high: number; low: number; close: number }[],
  configJson: string,
  buyThreshold: number,
  sellThreshold: number,
): (i: number) => "BUY" | "SELL" | "HOLD" {
  const series = obiProxySeries(candles, configJson);
  return (i) => {
    const v = series[i];
    if (!Number.isFinite(v)) return "HOLD";
    return v >= buyThreshold ? "BUY" : v <= sellThreshold ? "SELL" : "HOLD";
  };
}
