import type { Candle } from "@/modules/exchanges/types";
import { computeSignal, type StrategyIndicatorConfig } from "@/modules/signals/engine";
import { atr } from "@/modules/indicators/engine";
import { clamp } from "@/shared/utils";

/**
 * Backtest Engine — walks candles, computes signals on rolling windows,
 * simulates trades with fee, slippage, execution delay and partial fill.
 * Pure function — fully unit-testable, no DB access.
 */

export interface BacktestParams {
  candles: Candle[];
  indicators: StrategyIndicatorConfig[];
  buyThreshold: number;
  sellThreshold: number;
  initialBalance: number;
  riskPerTradePct: number; // % of equity allocated per trade
  stopLossPct: number;
  takeProfitPct: number;
  trailingStop: boolean;
  trailingStopPct?: number;
  /** dynamic SL/TP from ATR — overrides pct-based stops when present */
  atrStops?: { period: number; slMultiplier: number; tpMultiplier: number };
  feePct: number;        // e.g. 0.25
  slippagePct: number;   // e.g. 0.05
  executionDelayMs?: number; // shifts fill to a later candle
  partialFill?: boolean;    // simulate 85% fill
  minCandles?: number;      // warmup window for indicators (default 60)
  /** signal source override — e.g. OBI proxy; when set, `indicators` are unused for signals */
  signalFn?: (i: number) => "BUY" | "SELL" | "HOLD";
}

export interface SimTrade {
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  amount: number;
  fee: number;
  pnl: number;
  pnlPct: number;
  entryTime: number;
  exitTime: number;
  exitReason: string;
}

export interface BacktestResult {
  initialBalance: number;
  finalBalance: number;
  netProfit: number;
  profitPct: number;
  winRate: number;
  lossRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgProfit: number;
  avgLoss: number;
  maxDrawdown: number; // percent
  profitFactor: number;
  largestWin: number;
  largestLoss: number;
  avgTradeDurationMin: number;
  equityCurve: { t: number; equity: number }[];
  trades: SimTrade[];
}

export function runBacktest(p: BacktestParams): BacktestResult {
  const warmup = p.minCandles ?? 60;
  const feeRate = p.feePct / 100;
  const slip = p.slippagePct / 100;
  const delayCandles = p.executionDelayMs ? Math.max(1, Math.round(p.executionDelayMs / 60_000)) : 0;

  let balance = p.initialBalance;
  const atrSeries = p.atrStops ? atr(p.candles, p.atrStops.period) : null;
  const evalSignal = (i: number): "BUY" | "SELL" | "HOLD" =>
    p.signalFn
      ? p.signalFn(i)
      : computeSignal(p.indicators, p.candles.slice(0, i + 1), p.buyThreshold, p.sellThreshold).signal;

  let openPosition: {
    entryPrice: number; amount: number; invested: number; entryIdx: number; peak: number;
    slPrice: number; tpPrice: number;
  } | null = null;
  const trades: SimTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];

  for (let i = warmup; i < p.candles.length; i++) {
    const c = p.candles[i];

    // mark-to-market equity
    const equity = balance + (openPosition ? openPosition.amount * c.close : 0);
    equityCurve.push({ t: c.time, equity });

    // manage open position first (SL/TP/trailing checked on candle extremes)
    if (openPosition) {
      const pos = openPosition;
      pos.peak = Math.max(pos.peak, c.high);
      const entry = pos.entryPrice;
      let exitPrice: number | null = null;
      let exitReason = "";

      const slPrice = pos.slPrice;
      const tpPrice = pos.tpPrice;
      const trailPrice = p.trailingStop && p.trailingStopPct
        ? pos.peak * (1 - p.trailingStopPct / 100)
        : null;

      if (c.low <= slPrice) { exitPrice = slPrice; exitReason = "STOP_LOSS"; }
      else if (c.high >= tpPrice) { exitPrice = tpPrice; exitReason = "TAKE_PROFIT"; }
      else if (trailPrice !== null && pos.peak > entry && c.low <= trailPrice) {
        exitPrice = trailPrice; exitReason = "TRAILING_STOP";
      }

      if (exitPrice === null) {
        // signal-driven exit
        if (evalSignal(i) === "SELL") { exitPrice = c.close; exitReason = "SIGNAL"; }
      }

      if (exitPrice !== null) {
        const fillPrice = exitPrice * (1 - slip); // sell slippage
        const proceeds = pos.amount * fillPrice;
        const fee = proceeds * feeRate;
        const pnl = proceeds - fee - pos.invested;
        balance += proceeds - fee;
        trades.push({
          side: "BUY",
          entryPrice: pos.entryPrice,
          exitPrice: fillPrice,
          amount: pos.amount,
          fee,
          pnl,
          pnlPct: (pnl / pos.invested) * 100,
          entryTime: p.candles[pos.entryIdx].time,
          exitTime: c.time,
          exitReason,
        });
        openPosition = null;
        continue;
      }
    }

    // entry logic — only when flat
    if (!openPosition && i + delayCandles < p.candles.length) {
      if (evalSignal(i) === "BUY" && balance > 0) {
        const execIdx = Math.min(i + delayCandles, p.candles.length - 1);
        const execCandle = p.candles[execIdx];
        const fillPrice = execCandle.open * (1 + slip); // buy slippage
        const fillFactor = p.partialFill ? 0.85 : 1;
        const invested = Math.min(balance * (p.riskPerTradePct / 100) * fillFactor, balance);
        if (invested <= 0) continue;
        const entryFee = invested * feeRate;
        const amount = (invested - entryFee) / fillPrice;
        balance -= invested;
        // ATR-based dynamic stops at entry, else fixed pct
        const a = atrSeries?.[execIdx];
        const slPrice = p.atrStops && Number.isFinite(a)
          ? fillPrice - a! * p.atrStops.slMultiplier
          : fillPrice * (1 - p.stopLossPct / 100);
        const tpPrice = p.atrStops && Number.isFinite(a)
          ? fillPrice + a! * p.atrStops.tpMultiplier
          : fillPrice * (1 + p.takeProfitPct / 100);
        openPosition = { entryPrice: fillPrice, amount, invested, entryIdx: execIdx, peak: fillPrice, slPrice, tpPrice };
      }
    }
  }

  // force-close at last candle
  if (openPosition) {
    const last = p.candles[p.candles.length - 1];
    const fillPrice = last.close * (1 - slip);
    const proceeds = openPosition.amount * fillPrice;
    const fee = proceeds * feeRate;
    const pnl = proceeds - fee - openPosition.invested;
    balance += proceeds - fee;
    trades.push({
      side: "BUY",
      entryPrice: openPosition.entryPrice,
      exitPrice: fillPrice,
      amount: openPosition.amount,
      fee,
      pnl,
      pnlPct: (pnl / openPosition.invested) * 100,
      entryTime: p.candles[openPosition.entryIdx].time,
      exitTime: last.time,
      exitReason: "END",
    });
  }

  return summarizeResult(p.initialBalance, balance, trades, equityCurve);
}

/**
 * Metrics shared by all backtest engines — win rate, drawdown (from the
 * mark-to-market equity curve), profit factor, duration stats.
 */
export function summarizeResult(
  initialBalance: number,
  finalBalance: number,
  trades: SimTrade[],
  equityCurve: { t: number; equity: number }[],
): BacktestResult {
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const durations = trades.map((t) => (t.exitTime - t.entryTime) / 60_000);

  let peak = initialBalance;
  let maxDrawdown = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - e.equity) / peak) * 100);
  }

  return {
    initialBalance,
    finalBalance,
    netProfit: finalBalance - initialBalance,
    profitPct: initialBalance > 0 ? ((finalBalance - initialBalance) / initialBalance) * 100 : 0,
    winRate: trades.length ? (winners.length / trades.length) * 100 : 0,
    lossRate: trades.length ? (losers.length / trades.length) * 100 : 0,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    avgProfit: winners.length ? grossProfit / winners.length : 0,
    avgLoss: losers.length ? grossLoss / losers.length : 0,
    maxDrawdown: clamp(maxDrawdown, 0, 100),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    largestWin: winners.length ? Math.max(...winners.map((t) => t.pnl)) : 0,
    largestLoss: losers.length ? Math.min(...losers.map((t) => t.pnl)) : 0,
    avgTradeDurationMin: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    equityCurve,
    trades,
  };
}
