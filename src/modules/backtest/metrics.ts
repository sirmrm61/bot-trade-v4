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
  daysAbove05Pct: number;    // share of days hitting the min target
  daysAbove1Pct: number;     // share of days hitting the normal target
  daysAbove5Pct: number;     // share of days hitting the stretch target
  meanDailyPct: number;
  worstDayPct: number;
  worst7DayPct: number;      // worst rolling 7-day cumulative return
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
    daysAbove05Pct: daily.length ? (daily.filter((d) => d >= 0.5).length / daily.length) * 100 : 0,
    daysAbove1Pct: daily.length ? (daily.filter((d) => d >= 1).length / daily.length) * 100 : 0,
    daysAbove5Pct: daily.length ? (daily.filter((d) => d >= 5).length / daily.length) * 100 : 0,
    meanDailyPct: dMean,
    worstDayPct: daily.length ? Math.min(...daily) : 0,
    worst7DayPct: worstRolling(daily, 7),
  };
}

/** worst cumulative return over any rolling `n`-day window (0 if fewer days) */
function worstRolling(daily: number[], n: number): number {
  if (daily.length < n) return daily.length ? daily.reduce((a, b) => a + b, 0) : 0;
  let worst = Infinity;
  for (let i = 0; i + n <= daily.length; i++) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += daily[j];
    if (s < worst) worst = s;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// daily state machine simulation — does the day-level goal layer actually
// help, or does it just cost opportunity? Replayed over the same SimTrade[]
// stream: day PnL drives BUILDING→PROTECTING→LOCKED/DEFENSIVE transitions
// exactly like the live daily-plan module.
// ---------------------------------------------------------------------------

export interface DailyMachineComparison {
  withMachine: ExtendedMetrics;
  without: ExtendedMetrics;
  /** positive = the machine helped (more profit AND less drawdown → adopt) */
  verdict: "ADOPT" | "REJECT" | "NEUTRAL";
  note: string;
}

export function simulateDailyStateMachine(result: BacktestResult): DailyMachineComparison {
  const trades = [...result.trades].sort((a, b) => a.entryTime - b.entryTime);
  const kept: SimTrade[] = [];

  let dayKey = "";
  let dayPnlPct = 0;
  let dayPeak = 0;
  let dayTrades = 0;
  let state: "BUILDING" | "PROTECTING" | "LOCKED" | "DEFENSIVE" = "BUILDING";
  const cap = result.initialBalance;

  for (const t of trades) {
    const d = new Date(t.entryTime).toISOString().slice(0, 10);
    if (d !== dayKey) { dayKey = d; dayPnlPct = 0; dayPeak = 0; dayTrades = 0; state = "BUILDING"; }
    if (state === "LOCKED" || dayTrades >= 8) continue;

    const scale = state === "PROTECTING" || state === "DEFENSIVE" ? 0.5 : 1;
    const adj: SimTrade = { ...t, pnl: t.pnl * scale, pnlPct: t.pnlPct * scale, amount: t.amount * scale };
    kept.push(adj);
    dayTrades++;

    // update the day's state AFTER this trade's pnl (approximation: entry-time
    // day — exits landing next day book into the exit day below)
    const exitDay = new Date(t.exitTime).toISOString().slice(0, 10);
    if (exitDay === dayKey) {
      dayPnlPct += (t.pnl * scale / cap) * 100;
      dayPeak = Math.max(dayPeak, dayPnlPct);
      if (dayPnlPct <= -1) state = "DEFENSIVE";
      else if (dayPnlPct >= 5) state = "LOCKED";
      else if (dayPnlPct >= 1) {
        state = "PROTECTING";
        if (dayPeak > 0 && (dayPeak - dayPnlPct) / dayPeak > 0.4) state = "LOCKED";
      }
    }
  }

  const without = extendedMetrics(result);
  const withMachine = extendedMetrics({ ...result, trades: kept });
  let verdict: DailyMachineComparison["verdict"] = "NEUTRAL";
  let note = "تفاوت معنادار نیست";
  if (withMachine.totalTrades < without.totalTrades * 0.7 && withMachine.profitPct < without.profitPct) {
    verdict = "REJECT";
    note = "ماشین‌حالت سود را بیش از حد قربانی کرد";
  } else if (withMachine.maxDrawdownPct < without.maxDrawdownPct * 0.8 && withMachine.profitPct >= without.profitPct * 0.9) {
    verdict = "ADOPT";
    note = "دراوداون کمتر با سود مشابه — ماشین‌حالت ارزش دارد";
  }
  return { withMachine, without, verdict, note };
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
