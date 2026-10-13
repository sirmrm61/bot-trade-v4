import type { Candle } from "@/modules/exchanges/types";
import { swingPoints } from "@/modules/trading/price-action";
import { atr } from "@/modules/indicators/engine";
import { clamp } from "@/shared/utils";

/**
 * S/R level extraction — fractal swing highs/lows merged into price clusters.
 * Every level carries a Persian `source` tag (سوینگ / کلاستر) so Setup.levelsMeta
 * can record exactly where each price came from — no guessed numbers.
 */

export interface SrLevel {
  price: number;
  /** which swing family produced it — a level's role (support/resistance) is
   *  decided by position vs current price, not by origin */
  origin: "HIGH" | "LOW";
  source: string;          // «سوینگ 4h» | «کلاستر 4h ×3»
  touches: number;         // cluster size — more touches = stronger level
  lastIdx: number;         // candle index of the most recent touch
  strength: number;        // 0..1 — touches + recency
}

export interface ExtractLevelsOpts {
  timeframe: string;       // label embedded in source tags («4h»)
  swingLen?: number;       // fractal width each side (default 3)
  clusterTolAtr?: number;  // cluster merge tolerance in ATR units (default 0.35)
}

export function extractLevels(candles: Candle[], opts: ExtractLevelsOpts): SrLevel[] {
  const n = candles.length;
  if (n < 30) return [];
  const k = Math.max(1, Math.floor(opts.swingLen ?? 3));
  const price = candles[n - 1].close;
  const a = atr(candles, 14).at(-1);
  const tol = Math.max(price * 0.004, (Number.isFinite(a) ? (a ?? 0) : 0) * (opts.clusterTolAtr ?? 0.35));
  if (tol <= 0) return [];

  const sw = swingPoints(candles, k);
  const pts = [
    ...sw.highs.map((s) => ({ price: s.price, i: s.i, origin: "HIGH" as const })),
    ...sw.lows.map((s) => ({ price: s.price, i: s.i, origin: "LOW" as const })),
  ].sort((x, y) => x.price - y.price);

  // greedy merge: a point joins the running cluster while within tol of its mean
  const levels: SrLevel[] = [];
  let cluster: typeof pts = [];
  const flush = () => {
    if (!cluster.length) return;
    const mean = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
    const lastIdx = Math.max(...cluster.map((p) => p.i));
    const touches = cluster.length;
    const highs = cluster.filter((p) => p.origin === "HIGH").length;
    const recency = clamp((lastIdx / Math.max(n - 1, 1)) * 0.3, 0, 0.3);
    levels.push({
      price: mean,
      origin: highs * 2 >= touches ? "HIGH" : "LOW",
      source: touches > 1 ? `کلاستر ${opts.timeframe} ×${touches}` : `سوینگ ${opts.timeframe}`,
      touches,
      lastIdx,
      strength: clamp(touches / 3 + recency, 0, 1),
    });
    cluster = [];
  };
  for (const p of pts) {
    if (cluster.length && Math.abs(p.price - cluster.reduce((s, q) => s + q.price, 0) / cluster.length) > tol) {
      flush();
    }
    cluster.push(p);
  }
  flush();
  return levels.sort((x, y) => x.price - y.price);
}

/** Levels strictly above `price`, nearest first. */
export function levelsAbove(levels: SrLevel[], price: number): SrLevel[] {
  return levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price);
}

/** Levels strictly below `price`, nearest first. */
export function levelsBelow(levels: SrLevel[], price: number): SrLevel[] {
  return levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price);
}
