import type { BacktestResult, SimTrade } from "./engine";

/**
 * Extended backtest metrics — the numbers the acceptance gate and the
 * self-improvement loop actually judge a strategy on. Derived from the
 * engine's SimTrade[] + equity curve, pure computation.
 */

export interface ExtendedMetrics {
  // core (mirrors BacktestResult, kept for one-shot serialization)
  profitPct: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
  profitFactor: number;
  // expectancy
  expectancy: number;        // mean pnlPct per trade, after fees
  avgWinPct: number;
  avgLossPct: number;
  payoffRatio: number;       // avgWin / |avgLoss|
  // risk-adjusted
  sharpe: number;            // annualized, √365 (crypto trades 24/7)
  sortino: number;           // downside deviation only
  maxConsecLosses: number;
  // daily distribution
  days: number;
  profitableDaysPct: number;
  daysAbove5Pct: number;     // share of days hitting the stretch target
  meanDailyPct: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** bucket closed trades by their exit day → daily return % of equity */
export function dailyReturns(trades: SimTrade[], initialBalance: number): number[] {
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const day = new Date(t.exitTime).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
  }
  return [...byDay.values()].map((pnl) => (pnl / initialBalance) * 100);
}

export function extendedMetrics(result: BacktestResult): ExtendedMetrics {
  const wins = result.trades.filter((t) => t.pnlPct > 0);
  const losses = result.trades.filter((t) => t.pnlPct <= 0);
  const avgWinPct = mean(wins.map((t) => t.pnlPct));
  const avgLossPct = Math.abs(mean(losses.map((t) => t.pnlPct)));

  const daily = dailyReturns(result.trades, result.initialBalance);
  const dMean = mean(daily);
  const dStd = std(daily);
  const downside = daily.filter((d) => d < 0);
  const dDev = downside.length ? Math.sqrt(mean(downside.map((d) => d ** 2))) : 0;

  let streak = 0, maxStreak = 0;
  for (const t of result.trades) {
    streak = t.pnlPct <= 0 ? streak + 1 : 0;
    if (streak > maxStreak) maxStreak = streak;
  }

  return {
    profitPct: result.profitPct,
    winRate: result.winRate,
    totalTrades: result.totalTrades,
    maxDrawdownPct: result.maxDrawdown,
    profitFactor: result.profitFactor,
    expectancy: mean(result.trades.map((t) => t.pnlPct)),
    avgWinPct, avgLossPct,
    payoffRatio: avgLossPct > 0 ? avgWinPct / avgLossPct : avgWinPct > 0 ? Infinity : 0,
    sharpe: dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0,
    sortino: dDev > 0 ? (dMean / dDev) * Math.sqrt(365) : 0,
    maxConsecLosses: maxStreak,
    days: daily.length,
    profitableDaysPct: daily.length ? (daily.filter((d) => d > 0).length / daily.length) * 100 : 0,
    daysAbove5Pct: daily.length ? (daily.filter((d) => d >= 5).length / daily.length) * 100 : 0,
    meanDailyPct: dMean,
  };
}

// ---------------------------------------------------------------------------
// acceptance gate — what a strategy must prove before going (or staying) live
// ---------------------------------------------------------------------------

export interface Acceptance {
  passed: boolean;
  reasons: string[];
}

export const ACCEPTANCE = {
  MIN_TRADES: 30,
  MIN_PROFIT_FACTOR: 1.3,
  MIN_EXPECTANCY_PCT: 0,      // after fees
  MAX_DRAWDOWN_PCT: 8,
  /** test must not degrade more than this fraction vs train (overfit guard) */
  MAX_TEST_DEGRADATION: 0.5,
} as const;

export function acceptanceCheck(
  train: ExtendedMetrics,
  test: ExtendedMetrics,
): Acceptance {
  const reasons: string[] = [];
  const totalTrades = train.totalTrades + test.totalTrades;
  if (totalTrades < ACCEPTANCE.MIN_TRADES) {
    reasons.push(`معاملات ناکافی: ${totalTrades} < ${ACCEPTANCE.MIN_TRADES}`);
  }
  if (test.profitFactor < ACCEPTANCE.MIN_PROFIT_FACTOR) {
    reasons.push(`پرافیت‌فکتور تست ${test.profitFactor.toFixed(2)} < ${ACCEPTANCE.MIN_PROFIT_FACTOR}`);
  }
  if (test.expectancy <= ACCEPTANCE.MIN_EXPECTANCY_PCT) {
    reasons.push(`اکسپکتنسی تست ${test.expectancy.toFixed(3)}٪ ≤ ۰`);
  }
  if (test.maxDrawdownPct > ACCEPTANCE.MAX_DRAWDOWN_PCT) {
    reasons.push(`دراوداون تست ${test.maxDrawdownPct.toFixed(1)}٪ > ${ACCEPTANCE.MAX_DRAWDOWN_PCT}٪`);
  }
  // overfit detection — test PF collapses vs train
  if (train.profitFactor > 0 && Number.isFinite(train.profitFactor) && Number.isFinite(test.profitFactor)) {
    const degradation = 1 - test.profitFactor / train.profitFactor;
    if (degradation > ACCEPTANCE.MAX_TEST_DEGRADATION) {
      reasons.push(`افت عملکرد تست نسبت به آموزش ${(degradation * 100).toFixed(0)}٪ — نشانه‌ی اورفیت`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}
