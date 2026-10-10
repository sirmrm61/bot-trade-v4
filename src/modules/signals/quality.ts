import type { Candle } from "@/modules/exchanges/types";
import { rsi, ema, atr } from "@/modules/indicators/engine";
import { marketStats } from "@/modules/strategies/suggest";

/**
 * Entry quality scorer — the fix for "good exits, bad entries".
 *
 * A raw engine signal (cross/breakout/pattern) only proves SOMETHING
 * happened on this timeframe. Whether it's worth trading depends on the
 * context around it. This scorer blends five evidence components into a
 * 0..1 score; the live engine and backtest both gate on it.
 *
 * Components (weights):
 *   trend  .30 — higher-TF direction agrees with the side
 *   momentum .20 — RSI in a tradeable band (not chasing, not knife-catching)
 *   volume .15 — participation confirms the move
 *   structure .20 — distance to S/R in ATR terms (not buying resistance)
 *   regime .15 — market regime compatible with a directional entry
 */

export interface QualityResult {
  score: number;          // 0..1 composite
  regime: "trending" | "ranging" | "volatile";
  components: Record<string, number>;
  blocked?: string;       // hard-block reason (untradeable regime)
}

/** aggregate candles into `factor`× larger pseudo-candles (HTF proxy) */
export function resample(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const grp = candles.slice(i, i + factor);
    out.push({
      time: grp[0].time,
      open: grp[0].open,
      high: Math.max(...grp.map((c) => c.high)),
      low: Math.min(...grp.map((c) => c.low)),
      close: grp.at(-1)!.close,
      volume: grp.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function entryQuality(candles: Candle[], side: "LONG" | "SHORT"): QualityResult {
  const long = side === "LONG";
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1) ?? 0;
  const atrNow = atr(candles, 14).at(-1) ?? 0;
  const atrPct = price > 0 ? (atrNow / price) * 100 : 0;

  // ---- 1. higher-TF trend (4× base timeframe) — weight .30
  const htf = resample(candles, 4);
  let trend = 0.5;
  if (htf.length >= 30) {
    const hc = htf.map((c) => c.close);
    const e20 = ema(hc, 20).at(-1) ?? 0;
    const e50 = ema(hc, Math.min(50, htf.length - 1)).at(-1) ?? 0;
    const hPrice = hc.at(-1)!;
    const align = long ? hPrice > e20 && e20 > e50 : hPrice < e20 && e20 < e50;
    const against = long ? hPrice < e20 && e20 < e50 : hPrice > e20 && e20 > e50;
    trend = align ? 1 : against ? 0.1 : 0.5;
  }

  // ---- 2. momentum — weight .20 (long: sweet spot 45–68, fading >78)
  const r = rsi(closes, 14).at(-1) ?? 50;
  let momentum: number;
  if (long) {
    momentum = r < 30 ? 0.35 : r < 45 ? 0.6 : r <= 68 ? 1 : r <= 78 ? 0.5 : 0.2;
  } else {
    momentum = r > 70 ? 0.35 : r > 55 ? 0.6 : r >= 32 ? 1 : r >= 22 ? 0.5 : 0.2;
  }

  // ---- 3. volume participation — weight .15
  const vols = candles.map((c) => c.volume);
  const base = vols.slice(-60, -10);
  const recent = vols.slice(-10);
  const baseMean = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
  const recentMean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const volRatio = baseMean > 0 ? recentMean / baseMean : 1;
  const volume = clamp01(volRatio / 1.5); // 1.5× avg volume → full marks

  // ---- 4. structure — weight .20 (distance to nearest opposing swing)
  const lookback = candles.slice(-60);
  const swingHi = Math.max(...lookback.map((c) => c.high));
  const swingLo = Math.min(...lookback.map((c) => c.low));
  // for longs: room to the swing high; for shorts: room to the swing low
  const room = atrNow > 0
    ? (long ? (swingHi - price) / atrNow : (price - swingLo) / atrNow)
    : 2;
  const structure = room <= 0 ? 0.1 : clamp01(room / 3); // ≥3 ATR of room → full

  // ---- 5. regime — weight .15, plus hard-block on hostile regimes
  const stats = marketStats(n >= 60 ? candles.slice(-120) : candles);
  let regime = 0.5;
  let blocked: string | undefined;
  if (stats.regime === "volatile") {
    regime = 0.2;
    // extreme vol regime — don't enter; entries mid-chaos are the losers
    if (stats.volPct > 4) blocked = "volatile";
  } else if (stats.regime === "trending") {
    const withTrend = (stats.trendPct > 0) === long;
    regime = withTrend ? 1 : 0.35;
  } else {
    regime = 0.35; // ranging — directional entries are coin flips
  }

  const score =
    0.30 * trend + 0.20 * momentum + 0.15 * volume + 0.20 * structure + 0.15 * regime;

  return {
    score: Math.round(score * 1000) / 1000,
    regime: stats.regime,
    components: {
      trend: round3(trend), momentum: round3(momentum), volume: round3(volume),
      structure: round3(structure), regime: round3(regime),
      rsi: Math.round(r * 10) / 10, atrPct: Math.round(atrPct * 100) / 100,
      volRatio: round3(volRatio),
    },
    blocked,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
