import type { Candle } from "@/modules/exchanges/types";
import type { BacktestResult } from "./engine";
import { simulateVersion } from "./service";
import { extendedMetrics, acceptanceCheck, type ExtendedMetrics, type Acceptance } from "./metrics";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";

/**
 * Walk-forward validation — the overfit filter.
 *
 * Splits the candle window into a train slice (first `trainRatio`) and an
 * out-of-sample test slice. A strategy version is only "validated" when
 * it clears the acceptance gate on data it never saw during tuning.
 */

export interface WalkForwardResult {
  train: { result: BacktestResult; metrics: ExtendedMetrics };
  test: { result: BacktestResult; metrics: ExtendedMetrics };
  acceptance: Acceptance;
}

interface VersionForSim {
  kind: string; config: string; buyThreshold: number; sellThreshold: number;
  riskPerTradePct: number; stopLossPct: number; takeProfitPct: number;
  trailingStop: boolean; trailingStopPct: number | null;
  indicators: { name: string; parameters: string; enabled: boolean }[];
}

export async function runWalkForward(
  version: VersionForSim,
  indicators: StrategyIndicatorConfig[],
  candles: Candle[],
  sim: { initialBalance: number; feePct: number; slippagePct: number; symbol: string },
  trainRatio = 0.7,
): Promise<WalkForwardResult> {
  const split = Math.floor(candles.length * trainRatio);
  const trainCandles = candles.slice(0, split);
  const testCandles = candles.slice(split);
  if (trainCandles.length < 100 || testCandles.length < 60) {
    return {
      train: { result: emptyResult(sim.initialBalance), metrics: emptyMetrics() },
      test: { result: emptyResult(sim.initialBalance), metrics: emptyMetrics() },
      acceptance: { passed: false, reasons: [`داده‌ی کافی نیست — آموزش ${trainCandles.length} کندل، تست ${testCandles.length}`] },
    };
  }

  const [trainResult, testResult] = await Promise.all([
    simulateVersion(version, indicators, trainCandles, sim),
    simulateVersion(version, indicators, testCandles, sim),
  ]);
  const trainM = extendedMetrics(trainResult);
  const testM = extendedMetrics(testResult);
  return {
    train: { result: trainResult, metrics: trainM },
    test: { result: testResult, metrics: testM },
    acceptance: acceptanceCheck(trainM, testM),
  };
}

const emptyResult = (b: number): BacktestResult => ({
  initialBalance: b, finalBalance: b, netProfit: 0, profitPct: 0,
  winRate: 0, lossRate: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0,
  avgProfit: 0, avgLoss: 0, maxDrawdown: 0, profitFactor: 0,
  largestWin: 0, largestLoss: 0, avgTradeDurationMin: 0,
  equityCurve: [], trades: [],
});

const emptyMetrics = (): ExtendedMetrics => ({
  profitPct: 0, winRate: 0, totalTrades: 0, maxDrawdownPct: 0, profitFactor: 0,
  expectancy: 0, avgWinPct: 0, avgLossPct: 0, payoffRatio: 0,
  sharpe: 0, sortino: 0, maxConsecLosses: 0,
  days: 0, profitableDaysPct: 0, daysAbove05Pct: 0, daysAbove1Pct: 0,
  daysAbove5Pct: 0, meanDailyPct: 0, worstDayPct: 0, worst7DayPct: 0,
});
