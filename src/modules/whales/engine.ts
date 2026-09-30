import type { OrderBook } from "@/modules/exchanges/types";
import { clamp } from "@/shared/utils";

/**
 * Whale Watch — pure order-book analysis.
 *
 * Detects two phenomena:
 *  1. Walls — a single book level holding an outsized share of its side's
 *     depth (support/resistance a whale is defending).
 *  2. Imbalance — one side of the book dwarfing the other (pressure).
 *
 * Everything is sized in USD so thresholds are comparable across quotes.
 */

export interface WhaleConfig {
  /** a level must hold ≥ this fraction of its side's depth to count as a wall */
  wallSharePct: number;   // default 25
  /** and ≥ this absolute USD size (filters dust on thin books) */
  minWallUsd: number;     // default 50_000
  /** bid/ask depth ratio above which an imbalance event fires */
  imbalanceRatio: number; // default 2.5
  /** book depth summed for share/imbalance (levels) */
  depthLevels: number;    // default 20
}

export const WHALE_DEFAULTS: WhaleConfig = {
  wallSharePct: 25,
  minWallUsd: 50_000,
  imbalanceRatio: 2.5,
  depthLevels: 20,
};

export interface WhaleEventCalc {
  kind: "BID_WALL" | "ASK_WALL" | "IMBALANCE_BIDS" | "IMBALANCE_ASKS";
  mid: number;
  price: number | null;
  sizeUsd: number | null;
  distancePct: number | null;
  sharePct: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalance: number;
  score: number;
  reasons: string[];
}

function depthUsd(levels: [number, number][], n: number): number {
  return levels.slice(0, n).reduce((s, [p, a]) => s + p * a, 0);
}

/** Biggest wall on one side — the single level with the largest USD size. */
function biggestWall(
  levels: [number, number][],
  mid: number,
  sideDepth: number,
  cfg: WhaleConfig,
): { price: number; sizeUsd: number; sharePct: number; distancePct: number } | null {
  let best: { price: number; sizeUsd: number } | null = null;
  for (const [price, amount] of levels.slice(0, cfg.depthLevels)) {
    const usd = price * amount;
    if (!best || usd > best.sizeUsd) best = { price, sizeUsd: usd };
  }
  if (!best || best.sizeUsd < cfg.minWallUsd || sideDepth <= 0) return null;
  const sharePct = (best.sizeUsd / sideDepth) * 100;
  if (sharePct < cfg.wallSharePct) return null;
  return {
    price: best.price,
    sizeUsd: best.sizeUsd,
    sharePct,
    distancePct: (Math.abs(best.price - mid) / mid) * 100,
  };
}

export function detectWhales(book: OrderBook, cfg: WhaleConfig = WHALE_DEFAULTS): WhaleEventCalc[] {
  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  if (!bestBid || !bestAsk) return [];
  const mid = (bestBid + bestAsk) / 2;

  const bidDepth = depthUsd(book.bids, cfg.depthLevels);
  const askDepth = depthUsd(book.asks, cfg.depthLevels);
  const imbalance = askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? Infinity : 1;

  const out: WhaleEventCalc[] = [];
  const base = { mid, bidDepthUsd: round2(bidDepth), askDepthUsd: round2(askDepth), imbalance: round2(imbalance) };

  const bidWall = biggestWall(book.bids, mid, bidDepth, cfg);
  if (bidWall) {
    out.push({
      kind: "BID_WALL", ...base,
      price: bidWall.price, sizeUsd: round2(bidWall.sizeUsd),
      distancePct: round2(bidWall.distancePct), sharePct: round2(bidWall.sharePct),
      score: scoreWall(bidWall.sharePct, bidWall.sizeUsd, bidWall.distancePct),
      reasons: [
        `دیوار خرید $${fmtUsd(bidWall.sizeUsd)} روی ${bidWall.price}`,
        `${bidWall.sharePct.toFixed(0)}٪ از عمق خرید در یک سطح`,
        `فاصله از قیمت: ${bidWall.distancePct.toFixed(2)}٪ — حمایت نهنگ`,
      ],
    });
  }

  const askWall = biggestWall(book.asks, mid, askDepth, cfg);
  if (askWall) {
    out.push({
      kind: "ASK_WALL", ...base,
      price: askWall.price, sizeUsd: round2(askWall.sizeUsd),
      distancePct: round2(askWall.distancePct), sharePct: round2(askWall.sharePct),
      score: scoreWall(askWall.sharePct, askWall.sizeUsd, askWall.distancePct),
      reasons: [
        `دیوار فروش $${fmtUsd(askWall.sizeUsd)} روی ${askWall.price}`,
        `${askWall.sharePct.toFixed(0)}٪ از عمق فروش در یک سطح`,
        `فاصله از قیمت: ${askWall.distancePct.toFixed(2)}٪ — مقاومت نهنگ`,
      ],
    });
  }

  if (imbalance >= cfg.imbalanceRatio) {
    out.push({
      kind: "IMBALANCE_BIDS", ...base,
      price: null, sizeUsd: null, distancePct: null, sharePct: null,
      score: scoreImbalance(imbalance),
      reasons: [
        `عمق خرید ${imbalance.toFixed(1)} برابر عمق فروش است`,
        `فشار خرید نهنگ‌ها — $${fmtUsd(bidDepth)} در برابر $${fmtUsd(askDepth)}`,
      ],
    });
  } else if (imbalance <= 1 / cfg.imbalanceRatio && imbalance > 0) {
    out.push({
      kind: "IMBALANCE_ASKS", ...base,
      price: null, sizeUsd: null, distancePct: null, sharePct: null,
      score: scoreImbalance(1 / imbalance),
      reasons: [
        `عمق فروش ${(1 / imbalance).toFixed(1)} برابر عمق خرید است`,
        `فشار فروش نهنگ‌ها — $${fmtUsd(askDepth)} در برابر $${fmtUsd(bidDepth)}`,
      ],
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

/** Wall strength: bigger share + bigger size + closer to mid = scarier. */
function scoreWall(sharePct: number, sizeUsd: number, distancePct: number): number {
  const shareScore = clamp(sharePct / 60, 0, 1) * 45;           // 60% share → max
  const sizeScore = clamp(Math.log10(sizeUsd) / 7, 0, 1) * 35;  // $10M → max
  const distScore = clamp(1 - distancePct / 5, 0, 1) * 20;      // within 5% → max
  return Math.round(shareScore + sizeScore + distScore);
}

function scoreImbalance(ratio: number): number {
  return Math.round(clamp((ratio - 1) / 9, 0, 1) * 70 + 30); // 10× → 100
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const fmtUsd = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`);
