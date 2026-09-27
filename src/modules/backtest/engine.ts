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
  /** SPOT (default) long-only; FUTURES enables shorts + leverage + liquidation */
  market?: "SPOT" | "FUTURES";
  leverage?: number; // futures only, 1..10
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
  const futures = p.market === "FUTURES";
  const leverage = futures ? Math.max(p.leverage ?? 1, 1) : 1;

  let balance = p.initialBalance;
  const atrSeries = p.atrStops ? atr(p.candles, p.atrStops.period) : null;
  const evalSignal = (i: number): "BUY" | "SELL" | "HOLD" =>
    p.signalFn
      ? p.signalFn(i)
      : computeSignal(p.indicators, p.candles.slice(0, i + 1), p.buyThreshold, p.sellThreshold).signal;

  interface Position {
    side: "LONG" | "SHORT";
    entryPrice: number;
    amount: number;       // base units — futures: margin*leverage/price
    invested: number;     // quote spent (spot) / margin posted (futures)
    entryIdx: number;
    peak: number;         // best price since entry (long: max, short: min)
    slPrice: number;
    tpPrice: number;
    liqPrice?: number;    // futures only
  }
  let openPosition: Position | null = null;
  const trades: SimTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];

  /** direction-aware PnL at a price, before fees */
  const posPnl = (pos: Position, price: number) =>
    pos.side === "LONG" ? (price - pos.entryPrice) * pos.amount : (pos.entryPrice - price) * pos.amount;

  const closePosition = (pos: Position, rawExit: number, c: Candle, exitReason: string) => {
    // slippage always moves the fill against the position
    const fillPrice = pos.side === "LONG" ? rawExit * (1 - slip) : rawExit * (1 + slip);
    const notional = pos.amount * fillPrice;
    const fee = notional * feeRate;
    if (futures) {
      if (exitReason === "LIQUIDATED") {
        // isolated margin — the posted margin is lost
        trades.push({
          side: pos.side === "LONG" ? "BUY" : "SELL",
          entryPrice: pos.entryPrice, exitPrice: fillPrice, amount: pos.amount, fee,
          pnl: -pos.invested, pnlPct: -100,
          entryTime: p.candles[pos.entryIdx].time, exitTime: c.time, exitReason,
        });
        balance -= Math.min(fee, balance); // liquidation fee comes out of wallet
      } else {
        const pnl = posPnl(pos, fillPrice) - fee;
        balance += pos.invested + pnl; // release margin ± result
        trades.push({
          side: pos.side === "LONG" ? "BUY" : "SELL",
          entryPrice: pos.entryPrice, exitPrice: fillPrice, amount: pos.amount, fee,
          pnl, pnlPct: (pnl / pos.invested) * 100,
          entryTime: p.candles[pos.entryIdx].time, exitTime: c.time, exitReason,
        });
      }
    } else {
      const proceeds = pos.amount * fillPrice;
      const pnl = proceeds - fee - pos.invested;
      balance += proceeds - fee;
      trades.push({
        side: "BUY",
        entryPrice: pos.entryPrice, exitPrice: fillPrice, amount: pos.amount, fee,
        pnl, pnlPct: (pnl / pos.invested) * 100,
        entryTime: p.candles[pos.entryIdx].time, exitTime: c.time, exitReason,
      });
    }
  };

  for (let i = warmup; i < p.candles.length; i++) {
    const c = p.candles[i];

    // mark-to-market equity
    const equity = balance + (openPosition
      ? futures
        ? openPosition.invested + posPnl(openPosition, c.close)
        : openPosition.amount * c.close
      : 0);
    equityCurve.push({ t: c.time, equity });

    // manage open position first (SL/TP/trailing checked on candle extremes)
    if (openPosition) {
      const pos = openPosition;
      const long = pos.side === "LONG";
      pos.peak = long ? Math.max(pos.peak, c.high) : Math.min(pos.peak, c.low);
      const entry = pos.entryPrice;
      let exitPrice: number | null = null;
      let exitReason = "";

      // liquidation beats everything — margin is gone before SL logic matters
      if (pos.liqPrice !== undefined && (long ? c.low <= pos.liqPrice : c.high >= pos.liqPrice)) {
        exitPrice = pos.liqPrice; exitReason = "LIQUIDATED";
      } else if (long ? c.low <= pos.slPrice : c.high >= pos.slPrice) {
        exitPrice = pos.slPrice; exitReason = "STOP_LOSS";
      } else if (long ? c.high >= pos.tpPrice : c.low <= pos.tpPrice) {
        exitPrice = pos.tpPrice; exitReason = "TAKE_PROFIT";
      } else {
        const trailPrice = p.trailingStop && p.trailingStopPct
          ? long ? pos.peak * (1 - p.trailingStopPct / 100) : pos.peak * (1 + p.trailingStopPct / 100)
          : null;
        if (trailPrice !== null && (long ? pos.peak > entry && c.low <= trailPrice : pos.peak < entry && c.high >= trailPrice)) {
          exitPrice = trailPrice; exitReason = "TRAILING_STOP";
        }
      }

      if (exitPrice === null) {
        // signal-driven exit — opposite signal closes the position
        const sig = evalSignal(i);
        if ((long && sig === "SELL") || (!long && sig === "BUY")) {
          exitPrice = c.close; exitReason = "SIGNAL";
        }
      }

      if (exitPrice !== null) {
        closePosition(pos, exitPrice, c, exitReason);
        openPosition = null;
        continue;
      }
    }

    // entry logic — only when flat
    if (!openPosition && i + delayCandles < p.candles.length) {
      const sig = evalSignal(i);
      const side: "LONG" | "SHORT" | null =
        sig === "BUY" ? "LONG" : futures && sig === "SELL" ? "SHORT" : null;
      if (side && balance > 0) {
        const execIdx = Math.min(i + delayCandles, p.candles.length - 1);
        const execCandle = p.candles[execIdx];
        const long = side === "LONG";
        const fillPrice = long ? execCandle.open * (1 + slip) : execCandle.open * (1 - slip);
        const fillFactor = p.partialFill ? 0.85 : 1;
        const invested = Math.min(balance * (p.riskPerTradePct / 100) * fillFactor, balance);
        if (invested <= 0) continue;

        let amount: number;
        let feePaid: number;
        if (futures) {
          // invested = margin; notional = margin × leverage; fee on notional
          const notional = invested * leverage;
          feePaid = notional * feeRate;
          amount = (notional - feePaid) / fillPrice;
          balance -= invested;
        } else {
          feePaid = invested * feeRate;
          amount = (invested - feePaid) / fillPrice;
          balance -= invested;
        }

        const a = atrSeries?.[execIdx];
        const stops = p.atrStops;
        const useAtr = stops !== undefined && Number.isFinite(a);
        const slPrice = useAtr
          ? long ? fillPrice - a! * stops.slMultiplier : fillPrice + a! * stops.slMultiplier
          : long ? fillPrice * (1 - p.stopLossPct / 100) : fillPrice * (1 + p.stopLossPct / 100);
        const tpPrice = useAtr
          ? long ? fillPrice + a! * stops.tpMultiplier : fillPrice - a! * stops.tpMultiplier
          : long ? fillPrice * (1 + p.takeProfitPct / 100) : fillPrice * (1 - p.takeProfitPct / 100);
        const liqPrice = futures
          ? long
            ? fillPrice * (1 - 0.9 / leverage)
            : fillPrice * (1 + 0.9 / leverage)
          : undefined;
        // stop-loss must sit inside the liquidation distance — otherwise the
        // position dies at liq before the stop can fire; clamp the stop to liq
        const effSl = futures && liqPrice !== undefined
          ? long ? Math.max(slPrice, liqPrice) : Math.min(slPrice, liqPrice)
          : slPrice;
        openPosition = { side, entryPrice: fillPrice, amount, invested, entryIdx: execIdx, peak: fillPrice, slPrice: effSl, tpPrice, liqPrice };
      }
    }
  }

  // force-close at last candle
  if (openPosition) {
    const last = p.candles[p.candles.length - 1];
    closePosition(openPosition, last.close, last, "END");
    openPosition = null;
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
