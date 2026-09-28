import { clamp } from "@/shared/utils";

/**
 * Scalping scanner — all weights, reference points and thresholds live here.
 * References define what counts as "perfect" (score 100) or "unacceptable"
 * (score 0) so every criterion maps a raw metric to 0..100 explainably.
 */

export interface ScalpWeights {
  liquidity: number;
  spread: number;
  depth: number;
  slippage: number;
  volatility: number;
  cost: number;
}

export interface ScalpConfig {
  weights: ScalpWeights;

  // --- scoring reference points ---
  volumeMinUsd: number;      // 24h USD volume at/below → liquidity 0
  volumeRefUsd: number;      // 24h USD volume at/above → liquidity 100 (log scale)
  depthBandPct: number;      // order-book depth measured within ±x% of mid
  depthMinUsd: number;       // depth within band at/below → 0
  depthRefUsd: number;       // depth within band at/above → 100 (log scale)
  spreadRefBadPct: number;   // spread ≥ → 0; 0 spread → 100 (linear)
  slippageRefBadPct: number; // one-way slippage ≥ → 0 (linear)
  volMinPct: number;         // volatility below → 0 (movement can't cover costs)
  volRefPct: number;         // realized per-candle vol → 100 (linear cap)
  volDayRefPct: number;      // 24h range fallback for pairs without candles → 100
  feePctPerSide: number;     // estimated taker fee per side (user-adjustable)
  costRefBadPct: number;     // round-trip cost ≥ → 0 (linear)

  // --- hard thresholds → pair is EXCLUDED ---
  hardMinVolumeUsd: number;
  maxSpreadPct: number;
  maxCostPct: number;
  maxBookStaleMs: number;        // order-book older than this → book metrics unusable
  maxCandleStaleFactor: number;  // last candle older than factor×timeframe → stale
  minCompleteness: number;       // below → INSUFFICIENT_DATA (no score shown)

  // --- collection ---
  bookLimit: number;      // top-N pairs by USD volume get order-book + candle enrichment
  candleTimeframe: string;
  candleLookback: number; // candles used for realized volatility
  concurrency: number;
  cacheTtlMs: number;
  orderSizeUsd: number;   // hypothetical order notional for slippage estimate
}

export const SCALPING_DEFAULTS: ScalpConfig = {
  weights: { liquidity: 25, spread: 15, depth: 15, slippage: 15, volatility: 15, cost: 15 },

  volumeMinUsd: 10_000,
  volumeRefUsd: 5_000_000,
  depthBandPct: 0.5,
  depthMinUsd: 500,
  depthRefUsd: 25_000,
  spreadRefBadPct: 1.0,
  slippageRefBadPct: 0.5,
  volMinPct: 0.02,
  volRefPct: 0.3,
  volDayRefPct: 6,
  // Nobitex spot taker fee is volume-tiered up to ~0.35%; default to the
  // conservative upper bound — users on lower tiers can lower it in settings.
  feePctPerSide: 0.35,
  costRefBadPct: 2.0,

  hardMinVolumeUsd: 10_000,
  maxSpreadPct: 1.5,
  maxCostPct: 2.5,
  maxBookStaleMs: 120_000,
  maxCandleStaleFactor: 6,
  minCompleteness: 0.5,

  bookLimit: 40,
  candleTimeframe: "5m",
  candleLookback: 48,
  concurrency: 4,
  cacheTtlMs: 45_000,
  orderSizeUsd: 100,
};

export const CRITERION_LABELS: Record<keyof ScalpWeights, string> = {
  liquidity: "نقدشوندگی (حجم ۲۴س)",
  spread: "اسپرد",
  depth: "عمق دفتر سفارش",
  slippage: "لغزش تخمینی",
  volatility: "نوسان کوتاه‌مدت",
  cost: "هزینه رفت‌وبرگشت",
};

export const CRITERION_KEYS = Object.keys(SCALPING_DEFAULTS.weights) as (keyof ScalpWeights)[];

/** Merge user overrides over defaults; unknown/invalid values are dropped, numbers clamped to sane ranges. */
export function mergeScalpConfig(overrides: Record<string, unknown> = {}): ScalpConfig {
  const cfg = { ...SCALPING_DEFAULTS, weights: { ...SCALPING_DEFAULTS.weights } };

  const num = (key: keyof Omit<ScalpConfig, "weights">, min: number, max: number) => {
    const v = Number(overrides[key]);
    if (Number.isFinite(v)) (cfg as unknown as Record<string, number>)[key] = clamp(v, min, max);
  };

  num("volumeMinUsd", 0, 1e12);
  num("volumeRefUsd", 1, 1e15);
  num("depthBandPct", 0.05, 5);
  num("depthMinUsd", 0, 1e12);
  num("depthRefUsd", 1, 1e12);
  num("spreadRefBadPct", 0.05, 20);
  num("slippageRefBadPct", 0.01, 20);
  num("volMinPct", 0, 10);
  num("volRefPct", 0.01, 50);
  num("volDayRefPct", 0.1, 100);
  num("feePctPerSide", 0, 5);
  num("costRefBadPct", 0.1, 50);
  num("hardMinVolumeUsd", 0, 1e12);
  num("maxSpreadPct", 0.05, 20);
  num("maxCostPct", 0.1, 50);
  num("maxBookStaleMs", 5_000, 30 * 60_000);
  num("maxCandleStaleFactor", 2, 100);
  num("minCompleteness", 0.2, 1);
  num("bookLimit", 0, 300);
  num("candleLookback", 10, 300);
  num("concurrency", 1, 10);
  num("orderSizeUsd", 1, 10_000_000);

  const tf = String(overrides.candleTimeframe ?? "");
  if (["1m", "3m", "5m", "15m", "30m", "1h"].includes(tf)) cfg.candleTimeframe = tf;

  const w = (overrides.weights ?? {}) as Record<string, unknown>;
  for (const k of CRITERION_KEYS) {
    const v = Number(w[k]);
    if (Number.isFinite(v)) cfg.weights[k] = clamp(v, 0, 100);
  }
  return cfg;
}
