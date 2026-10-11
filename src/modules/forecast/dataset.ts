import { prisma } from "@/infrastructure/database/prisma";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { atr } from "@/modules/indicators/engine";
import type { Candle } from "@/modules/exchanges/types";
import { precompute, featureVectorAt, type FeatureVector, type FeatureContext } from "./features";

/**
 * Triple-barrier labeling — for each candle i, look at the next N candles:
 *   label 1 → close_i + k·ATR_i touched first (up move)
 *   label 0 → close_i − k·ATR_i touched first (down move)
 *   skip    → neither barrier within the horizon (ambiguous — excluded from
 *             training so the model learns directional, not noise)
 *
 * The label uses FUTURE candles; features use only candles ≤ i. Split is a
 * hard time boundary (train = oldest 70%, test = newest 30%).
 */

export interface DatasetRow {
  time: number;
  features: FeatureVector;
  label: 0 | 1;
}

export interface Dataset {
  symbol: string;
  exchange: string;
  timeframe: string;
  horizonCandles: number;
  barrierK: number;
  rows: DatasetRow[];
  /** index where the TEST segment begins (rows[splitIdx..] is out-of-sample) */
  splitIdx: number;
  baseRate: number;      // P(label=1) on the whole labeled set — the honest baseline
}

export const HORIZON_CONFIGS = [
  { horizon: "5m", timeframe: "5m", horizonCandles: 1 },
  { horizon: "15m", timeframe: "15m", horizonCandles: 1 },
  { horizon: "1h", timeframe: "15m", horizonCandles: 4 },
  { horizon: "4h", timeframe: "1h", horizonCandles: 4 },
  { horizon: "12h", timeframe: "1h", horizonCandles: 12 },
] as const;

export type HorizonConfig = (typeof HORIZON_CONFIGS)[number];

/**
 * Label a candle index under the triple-barrier rule.
 * Returns 1 | 0 | null (neutral — neither barrier hit within `n` candles).
 */
export function tripleBarrierLabel(
  candles: Candle[],
  atrArr: number[],
  i: number,
  n: number,
  k: number,
): 0 | 1 | null {
  const a = atrArr[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  const entry = candles[i].close;
  const upper = entry + k * a;
  const lower = entry - k * a;
  const end = Math.min(i + n, candles.length - 1);
  for (let j = i + 1; j <= end; j++) {
    if (candles[j].high >= upper) return 1;
    if (candles[j].low <= lower) return 0;
  }
  return null;
}

/**
 * Build the labeled dataset for one (symbol, timeframe, horizon) config.
 * `days` bounds how far back we read; candle count grows ~linearly with days.
 */
export async function buildDataset(opts: {
  symbol: string;
  exchange: string;
  cfg: HorizonConfig;
  days?: number;
  k?: number;
  btcCandles?: Candle[];
}): Promise<Dataset> {
  const { cfg } = opts;
  const days = opts.days ?? 60;
  const k = opts.k ?? 1.5;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);

  const candles = await getCandles({
    symbol: opts.symbol, timeframe: cfg.timeframe,
    start, end, exchange: opts.exchange,
  });
  const atrArr = atr(candles, 14);
  const pre = precompute(candles);
  const ctx: FeatureContext = { btcCloses: opts.btcCandles?.map((c) => ({ time: c.time, close: c.close })) };

  const rows: DatasetRow[] = [];
  const warmupEnd = candles.length - cfg.horizonCandles - 1; // label needs full horizon
  for (let i = 96; i < warmupEnd; i++) {
    const label = tripleBarrierLabel(candles, atrArr, i, cfg.horizonCandles, k);
    if (label === null) continue;
    const f = featureVectorAt(candles, pre, i, ctx);
    if (!f) continue;
    rows.push({ time: candles[i].time, features: f, label });
  }

  const splitIdx = Math.floor(rows.length * 0.7);
  const baseRate = rows.length ? rows.filter((r) => r.label === 1).length / rows.length : 0.5;
  return {
    symbol: opts.symbol, exchange: opts.exchange,
    timeframe: cfg.timeframe, horizonCandles: cfg.horizonCandles, barrierK: k,
    rows, splitIdx, baseRate,
  };
}

/** candles for the BTC market proxy — same timeframe, cached in DB like the rest */
export async function btcContext(exchange: string, timeframe: string, days = 60): Promise<Candle[]> {
  const symbol = exchange === "KUCOIN" ? "BTC-USDT" : "BTCUSDT";
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  return getCandles({ symbol, timeframe, start, end, exchange }).catch(() => []);
}

/** which symbols have enough cached candles to train on */
export async function trainableSymbols(exchange: string, timeframe: string, minCandles = 300): Promise<string[]> {
  const since = new Date(Date.now() - 75 * 86_400_000);
  const rows = await prisma.historicalCandle.groupBy({
    by: ["symbol"],
    where: { exchange, timeframe, time: { gte: since } },
    _count: { symbol: true },
  });
  return rows.filter((r) => r._count.symbol >= minCandles).map((r) => r.symbol);
}
