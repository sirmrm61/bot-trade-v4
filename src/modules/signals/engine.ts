import type { Candle } from "@/modules/exchanges/types";
import {
  computeIndicator,
  evaluateCondition,
  defaultScore,
  NON_SCORING,
  type Condition,
  type IndicatorParams,
} from "@/modules/indicators/engine";
import { parseJson } from "@/shared/utils";

/**
 * Signal Engine — weighted scoring.
 *
 * Weighted Score = Σ (indicator score × weight)
 * Each indicator contributes a score in [-1, +1]:
 *   buyCondition met  → +1
 *   sellCondition met → -1
 *   otherwise         → continuous default score
 *
 * Final signal from thresholds:
 *   score >= buyThreshold  → BUY
 *   score <= sellThreshold → SELL
 *   else                   → HOLD
 */

export interface StrategyIndicatorConfig {
  name: string;
  parameters: IndicatorParams;
  weight: number;
  enabled: boolean;
  buyCondition?: Condition | string;
  sellCondition?: Condition | string;
}

export interface SignalResult {
  signal: "BUY" | "SELL" | "HOLD";
  score: number; // -1..+1
  breakdown: { name: string; weight: number; score: number; contribution: number }[];
}

export function computeSignal(
  indicators: StrategyIndicatorConfig[],
  candles: Candle[],
  buyThreshold: number,
  sellThreshold: number,
): SignalResult {
  const closes = candles.map((c) => c.close);
  const breakdown: SignalResult["breakdown"] = [];
  let totalWeight = 0;
  let weighted = 0;

  for (const ind of indicators) {
    if (!ind.enabled || ind.weight <= 0 || NON_SCORING.has(ind.name.toUpperCase())) continue;
    const series = computeIndicator(ind.name, ind.parameters, candles);

    const buyCond = parseJson<Condition | null>(
      typeof ind.buyCondition === "string" ? ind.buyCondition : JSON.stringify(ind.buyCondition ?? null),
      null,
    );
    const sellCond = parseJson<Condition | null>(
      typeof ind.sellCondition === "string" ? ind.sellCondition : JSON.stringify(ind.sellCondition ?? null),
      null,
    );

    let score: number;
    if (buyCond && evaluateCondition(buyCond, series, closes)) score = 1;
    else if (sellCond && evaluateCondition(sellCond, series, closes)) score = -1;
    else score = defaultScore(ind.name, series, closes);

    const contribution = score * ind.weight;
    weighted += contribution;
    totalWeight += ind.weight;
    breakdown.push({ name: ind.name, weight: ind.weight, score, contribution });
  }

  const score = totalWeight > 0 ? weighted / totalWeight : 0;
  const signal = score >= buyThreshold ? "BUY" : score <= sellThreshold ? "SELL" : "HOLD";
  return { signal, score, breakdown };
}

/**
 * Fast screening — computes each indicator series ONCE over the full candle
 * set, then evaluates the weighted score at every index. Returns how many
 * candles would have fired BUY/SELL. O(n × indicators) — much cheaper than
 * running a full backtest per candidate config.
 */
export function countSignals(
  indicators: StrategyIndicatorConfig[],
  candles: Candle[],
  buyThreshold: number,
  sellThreshold: number,
  fromIndex = 60,
): { buys: number; sells: number } {
  const closes = candles.map((c) => c.close);
  const active = indicators.filter(
    (i) => i.enabled && i.weight > 0 && !NON_SCORING.has(i.name.toUpperCase()),
  );
  const prepared = active.map((ind) => {
    try {
      return {
        ind,
        series: computeIndicator(ind.name, ind.parameters, candles),
        buyCond: parseJson<Condition | null>(
          typeof ind.buyCondition === "string" ? ind.buyCondition : JSON.stringify(ind.buyCondition ?? null),
          null,
        ),
        sellCond: parseJson<Condition | null>(
          typeof ind.sellCondition === "string" ? ind.sellCondition : JSON.stringify(ind.sellCondition ?? null),
          null,
        ),
      };
    } catch {
      return null;
    }
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  const totalWeight = prepared.reduce((a, s) => a + s.ind.weight, 0);
  if (totalWeight <= 0) return { buys: 0, sells: 0 };

  let buys = 0;
  let sells = 0;
  for (let i = Math.min(fromIndex, candles.length); i < candles.length; i++) {
    let weighted = 0;
    for (const { ind, series, buyCond, sellCond } of prepared) {
      let s: number;
      if (buyCond && evaluateCondition(buyCond, series, closes, i)) s = 1;
      else if (sellCond && evaluateCondition(sellCond, series, closes, i)) s = -1;
      else s = defaultScore(ind.name, series, closes, i);
      weighted += s * ind.weight;
    }
    const score = weighted / totalWeight;
    if (score >= buyThreshold) buys++;
    else if (score <= sellThreshold) sells++;
  }
  return { buys, sells };
}
