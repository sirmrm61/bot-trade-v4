import type { Candle } from "@/modules/exchanges/types";
import { computeSignal, type SignalResult, type StrategyIndicatorConfig } from "@/modules/signals/engine";
import { atr } from "@/modules/indicators/engine";
import { clamp } from "@/shared/utils";
import type { Tracer } from "@/modules/trace/tracer";
import { tradeTraceId } from "@/modules/trace/tracer";
import type { AmbiguityPolicy } from "@/modules/trace/types";
import { auditPnl } from "@/modules/trace/pnl-audit";

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
  /** signal source override — e.g. OBI proxy; when set, `indicators` are unused for signals.
   *  `holding` tells the fn the eval is an exit-check on an open position —
   *  learning wrappers use it to only record entry-candidate signals.
   *  May carry `onTradeClosed` — invoked with each closed trade's pnlPct so
   *  learning strategies (smart symbolic) can adapt inside the simulation. */
  signalFn?: ((i: number, holding?: boolean) => "BUY" | "SELL" | "HOLD") & {
    onTradeClosed?: (pnlPct: number, entryIdx: number, exitIdx: number) => void;
  };
  /** SPOT (default) long-only; FUTURES enables shorts + leverage + liquidation */
  market?: "SPOT" | "FUTURES";
  leverage?: number; // futures only, 1..10
  // ---- trace & debugging (all optional — zero behavior change when absent)
  tracer?: Tracer;
  symbol?: string;   // for trace events
  timeframe?: string;
  /** forbid fills on the signal bar (signal uses that bar's close → entry at
   *  its open would peek at the future). Default keeps legacy behavior but
   *  emits a LOOKAHEAD_BIAS warning; strict mode shifts entry to next bar. */
  strictCausality?: boolean;
  /** resolution when one candle touches both TP and SL (default SL_FIRST —
   *  matches the historical check order) */
  ambiguityPolicy?: AmbiguityPolicy;
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
  // ---- trace fields (populated only when a tracer is attached)
  traceId?: string;
  entryFee?: number;
  entryNotional?: number;
  rawEntryPrice?: number;   // candle open before slippage
  rawExitPrice?: number;    // trigger/close price before slippage
  slippageCost?: number;    // entry+exit slippage in quote
  ambiguousExit?: boolean;  // TP and SL both touched by the exit candle
  lookahead?: boolean;      // entered on the signal bar
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
  const tracer = p.tracer;
  const strict = p.strictCausality ?? false;
  const ambPolicy: AmbiguityPolicy = p.ambiguityPolicy ?? "SL_FIRST";

  /** full signal result — keeps the indicator breakdown for the trace */
  const evalSignalFull = (i: number, holding = false): SignalResult =>
    p.signalFn
      ? { signal: p.signalFn(i, holding), score: 0, breakdown: [] }
      : computeSignal(p.indicators, p.candles.slice(0, i + 1), p.buyThreshold, p.sellThreshold);

  interface Position {
    side: "LONG" | "SHORT";
    entryPrice: number;
    rawEntryPrice: number;
    entryFee: number;
    entryNotional: number;
    amount: number;       // base units — futures: margin*leverage/price
    invested: number;     // quote spent (spot) / margin posted (futures)
    entryIdx: number;
    signalIdx: number;
    peak: number;         // best price since entry (long: max, short: min)
    slPrice: number;
    tpPrice: number;
    liqPrice?: number;    // futures only
    traceId: string;
    lookahead: boolean;
  }
  let openPosition: Position | null = null;
  const trades: SimTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];

  /** direction-aware PnL at a price, before fees */
  const posPnl = (pos: Position, price: number) =>
    pos.side === "LONG" ? (price - pos.entryPrice) * pos.amount : (pos.entryPrice - price) * pos.amount;

  const closePosition = (pos: Position, rawExit: number, c: Candle, exitReason: string, exitIdx: number, ambiguous = false) => {
    // slippage always moves the fill against the position
    const fillPrice = pos.side === "LONG" ? rawExit * (1 - slip) : rawExit * (1 + slip);
    const notional = pos.amount * fillPrice;
    const fee = notional * feeRate;
    const balanceBefore = balance;
    const base = {
      traceId: pos.traceId || undefined,
      entryFee: pos.entryFee,
      entryNotional: pos.entryNotional,
      rawEntryPrice: pos.rawEntryPrice,
      rawExitPrice: rawExit,
      slippageCost:
        Math.abs(pos.entryPrice - pos.rawEntryPrice) * pos.amount +
        Math.abs(fillPrice - rawExit) * pos.amount,
      ambiguousExit: ambiguous || undefined,
      lookahead: pos.lookahead || undefined,
    };
    if (futures) {
      if (exitReason === "LIQUIDATED") {
        // isolated margin — the posted margin is lost
        trades.push({
          side: pos.side === "LONG" ? "BUY" : "SELL",
          entryPrice: pos.entryPrice, exitPrice: fillPrice, amount: pos.amount, fee,
          pnl: -pos.invested, pnlPct: -100,
          entryTime: p.candles[pos.entryIdx].time, exitTime: c.time, exitReason, ...base,
        });
        balance -= Math.min(fee, balance); // liquidation fee comes out of wallet
      } else {
        const pnl = posPnl(pos, fillPrice) - fee;
        balance += pos.invested + pnl; // release margin ± result
        trades.push({
          side: pos.side === "LONG" ? "BUY" : "SELL",
          entryPrice: pos.entryPrice, exitPrice: fillPrice, amount: pos.amount, fee,
          pnl, pnlPct: (pnl / pos.invested) * 100,
          entryTime: p.candles[pos.entryIdx].time, exitTime: c.time, exitReason, ...base,
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
        entryTime: p.candles[pos.entryIdx].time, exitTime: c.time, exitReason, ...base,
      });
    }
    const t = trades[trades.length - 1];

    // ---- EXIT trace — every cost component separately reconstructable
    tracer?.emit({
      stage: "EXIT", event: "POSITION_CLOSED", important: true,
      refId: pos.traceId, symbol: p.symbol, barIndex: exitIdx, candleTs: c.time,
      data: {
        exitReason, exitPrice: fillPrice, rawExitPrice: rawExit,
        quantity: pos.amount, holdingBars: exitIdx - pos.entryIdx,
        holdingTimeMs: c.time - p.candles[pos.entryIdx].time,
        grossPnl: posPnl(pos, fillPrice),
        entryFee: pos.entryFee, exitFee: fee,
        spreadCost: 0, // no order book in the simulation — recorded explicitly
        slippageCost: t.slippageCost, otherCosts: 0,
        totalCosts: pos.entryFee + fee + (t.slippageCost ?? 0),
        netPnl: t.pnl, returnPct: t.pnlPct,
        balanceBefore, balanceAfter: balance,
        ambiguousExit: ambiguous || undefined,
      },
    });

    // ---- PnL audit — recompute independently, flag any drift
    const audit = auditPnl({
      side: pos.side,
      rawEntryPrice: pos.rawEntryPrice, rawExitPrice: rawExit,
      fillEntryPrice: pos.entryPrice, fillExitPrice: fillPrice,
      amount: pos.amount, invested: pos.invested,
      entryFee: pos.entryFee, exitFee: fee,
      market: futures ? "FUTURES" : "SPOT",
      recordedPnl: t.pnl,
    });
    tracer?.emit({
      stage: "PNL_AUDIT", event: audit.ok ? "PNL_OK" : "PNL_MISMATCH", important: true,
      refId: pos.traceId, symbol: p.symbol, barIndex: exitIdx, candleTs: c.time,
      data: audit as unknown as Record<string, unknown>,
    });
    if (tracer) {
      const c_ = tracer.counters;
      c_.closedTrades++; c_.netProfit += t.pnl;
      c_.totalFees += pos.entryFee + fee;
      c_.totalSlippageCost += t.slippageCost ?? 0;
      if (t.pnl > 0) { c_.winningTrades++; c_.grossProfit += t.pnl; }
      else { c_.losingTrades++; c_.grossLoss += Math.abs(t.pnl); }
      if (exitReason === "TAKE_PROFIT") c_.tpCount++;
      else if (exitReason === "STOP_LOSS" || exitReason === "LIQUIDATED") c_.slCount++;
      else if (exitReason === "TRAILING_STOP") c_.trailingCount++;
      else if (exitReason === "SIGNAL") c_.signalExitCount++;
      else c_.otherExitCount++;
      if (ambiguous) c_.ambiguousExits++;
      if (!audit.ok) c_.pnlAuditErrors++;
    }
    p.signalFn?.onTradeClosed?.(t.pnlPct, pos.entryIdx, exitIdx);
  };

  for (let i = warmup; i < p.candles.length; i++) {
    const c = p.candles[i];
    if (tracer) tracer.counters.totalEvaluations++;

    // FULL trace — market snapshot for every evaluated bar
    tracer?.emit({
      stage: "SCANNER", event: "MARKET_SNAPSHOT",
      symbol: p.symbol, barIndex: i, candleTs: c.time,
      data: {
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, atr: atrSeries?.[i] ?? null,
        hasOpenPosition: !!openPosition,
      },
    });

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
      let ambiguous = false;

      const liqTouched = pos.liqPrice !== undefined && (long ? c.low <= pos.liqPrice : c.high >= pos.liqPrice);
      const slTouched = long ? c.low <= pos.slPrice : c.high >= pos.slPrice;
      const tpTouched = long ? c.high >= pos.tpPrice : c.low <= pos.tpPrice;

      // FULL trace — per-candle TP/SL evaluation while the position is open
      tracer?.emit({
        stage: "POSITION", event: "TP_SL_CHECK",
        refId: pos.traceId, symbol: p.symbol, barIndex: i, candleTs: c.time,
        data: {
          currentPrice: c.close, highestSinceEntry: pos.peak,
          unrealizedPnl: posPnl(pos, c.close),
          tpPrice: pos.tpPrice, slPrice: pos.slPrice,
          distanceToTP: Math.abs(pos.tpPrice - c.close),
          distanceToSL: Math.abs(pos.slPrice - c.close),
          tpTouched, slTouched, liqTouched,
        },
      });

      if (liqTouched) {
        // liquidation beats everything — margin is gone before SL logic matters
        exitPrice = pos.liqPrice!; exitReason = "LIQUIDATED";
      } else if (slTouched && tpTouched) {
        // one candle covered both exits — OHLC can't order them. Resolve by
        // the configured policy; TICK_DATA_REQUIRED resolves conservatively
        // but flags that candle resolution is insufficient.
        ambiguous = true;
        const pickSl = ambPolicy !== "TP_FIRST";
        exitPrice = pickSl ? pos.slPrice : pos.tpPrice;
        exitReason = pickSl ? "STOP_LOSS" : "TAKE_PROFIT";
        tracer?.emit({
          stage: "POSITION", event: "AMBIGUOUS_EXIT", important: true,
          refId: pos.traceId, symbol: p.symbol, barIndex: i, candleTs: c.time,
          data: {
            warning: "AMBIGUOUS_EXIT", policy: ambPolicy, resolvedTo: exitReason,
            tpPrice: pos.tpPrice, slPrice: pos.slPrice,
            candleHigh: c.high, candleLow: c.low,
            requiresTickData: ambPolicy === "TICK_DATA_REQUIRED",
          },
        });
      } else if (slTouched) {
        exitPrice = pos.slPrice; exitReason = "STOP_LOSS";
      } else if (tpTouched) {
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
        const r = evalSignalFull(i, true);
        if ((long && r.signal === "SELL") || (!long && r.signal === "BUY")) {
          exitPrice = c.close; exitReason = "SIGNAL";
        }
      }

      if (exitPrice !== null) {
        closePosition(pos, exitPrice, c, exitReason, i, ambiguous);
        openPosition = null;
        continue;
      }
    }

    // entry logic — only when flat
    if (!openPosition && i + delayCandles < p.candles.length) {
      const r = evalSignalFull(i);

      // FULL trace — the strategy evaluation with indicator breakdown and
      // the threshold filter that decided the signal
      tracer?.emit({
        stage: "STRATEGY", event: "SIGNAL_EVAL",
        symbol: p.symbol, barIndex: i, candleTs: c.time,
        data: {
          signal: r.signal, score: r.score,
          buyThreshold: p.buyThreshold, sellThreshold: p.sellThreshold,
          breakdown: r.breakdown,
          filters: [
            { filterName: "buy_threshold", result: r.score >= p.buyThreshold ? "PASS" : "FAIL",
              actualValue: r.score, threshold: p.buyThreshold, operator: ">=", reason: "score must reach buy threshold" },
            { filterName: "sell_threshold", result: r.score <= p.sellThreshold ? "PASS" : "FAIL",
              actualValue: r.score, threshold: p.sellThreshold, operator: "<=", reason: "score must reach sell threshold" },
          ],
        },
      });
      if (tracer) {
        tracer.counters.candidates++;
        if (r.signal !== "HOLD") tracer.counters.signals++;
      }

      const side: "LONG" | "SHORT" | null =
        r.signal === "BUY" ? "LONG" : futures && r.signal === "SELL" ? "SHORT" : null;

      if (r.signal === "SELL" && !futures) {
        tracer?.reject("STRATEGY", "SELL signal on spot — shorts not allowed");
      }
      if (side && balance <= 0) {
        tracer?.reject("RISK", "Insufficient balance for entry");
        tracer?.emit({
          stage: "RISK", event: "REJECTED", important: true,
          symbol: p.symbol, barIndex: i, candleTs: c.time,
          data: { rejectionStage: "RISK", primaryRejectReason: "Insufficient balance", balance },
        });
      }

      if (side && balance > 0) {
        let execIdx = i + delayCandles;
        let lookahead = false;

        // ---- look-ahead guard: entering on the signal bar's OPEN while the
        // signal consumed that bar's CLOSE is chronologically backwards.
        if (delayCandles === 0) {
          lookahead = true;
          if (strict) {
            // strict causality — the earliest honest fill is the next bar open
            execIdx = i + 1;
            if (execIdx >= p.candles.length) break;
            tracer?.emit({
              stage: "SYSTEM", event: "LOOKAHEAD_ENFORCED", important: true,
              symbol: p.symbol, barIndex: i, candleTs: c.time,
              data: { type: "LOOKAHEAD_BIAS", severity: "HIGH",
                detail: "same-bar entry moved to next bar open (strictCausality)" },
            });
          } else {
            if (tracer) tracer.counters.lookaheadWarnings++;
            tracer?.emit({
              stage: "SYSTEM", event: "LOOKAHEAD_BIAS", important: true,
              symbol: p.symbol, barIndex: i, candleTs: c.time,
              data: { type: "LOOKAHEAD_BIAS", severity: "HIGH",
                detail: "signal used this bar's close but fill is at this bar's open — set executionDelayMs>0 or strictCausality" },
            });
          }
        }
        execIdx = Math.min(execIdx, p.candles.length - 1);
        const execCandle = p.candles[execIdx];
        const long = side === "LONG";
        const fillPrice = long ? execCandle.open * (1 + slip) : execCandle.open * (1 - slip);
        const fillFactor = p.partialFill ? 0.85 : 1;
        const invested = Math.min(balance * (p.riskPerTradePct / 100) * fillFactor, balance);
        if (invested <= 0) {
          tracer?.reject("RISK", "Computed position size is zero");
          continue;
        }
        const tid = tracer?.enabled ? tradeTraceId(tracer.runId, trades.length + 1) : "";

        // ---- COST stage — pre-entry estimate, every component explicit
        const estNotional = futures ? invested * leverage : invested;
        const estEntryFee = estNotional * feeRate;
        const estExitFee = estNotional * feeRate;
        const estSlip = estNotional * slip * 2;
        const estTotalCost = estEntryFee + estExitFee + estSlip;
        const grossExpectPct = p.takeProfitPct; // planned reward leg
        const netExpectPct = grossExpectPct - (estTotalCost / invested) * 100;
        tracer?.emit({
          stage: "COST", event: "COST_ESTIMATE", important: true,
          refId: tid, symbol: p.symbol, barIndex: i, candleTs: c.time,
          data: {
            entryPrice: execCandle.open, quantity: estNotional / execCandle.open,
            notional: estNotional,
            entryFee: estEntryFee, exitFee: estExitFee,
            spreadCost: 0, // not modeled — no book inside the sim
            slippageEntry: estNotional * slip, slippageExit: estNotional * slip,
            otherCosts: 0, totalEstimatedCost: estTotalCost,
            grossExpectedReturnPct: grossExpectPct,
            estimatedCostPct: (estTotalCost / invested) * 100,
            netExpectedReturnPct: netExpectPct,
            formulas: {
              grossExpectedProfit: "expectedExitValue − expectedEntryValue",
              netExpectedProfit: "grossExpectedProfit − totalEstimatedCost",
            },
          },
        });

        const balanceBefore = balance;
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
        openPosition = {
          side, entryPrice: fillPrice, rawEntryPrice: execCandle.open,
          entryFee: feePaid, entryNotional: invested,
          amount, invested, entryIdx: execIdx, signalIdx: i,
          peak: fillPrice, slPrice: effSl, tpPrice, liqPrice,
          traceId: tid, lookahead,
        };
        if (tracer) tracer.counters.executedTrades++;

        // ---- ENTRY trace — full provenance of the fill
        tracer?.emit({
          stage: "ENTRY", event: "FILLED", important: true,
          refId: tid, symbol: p.symbol, barIndex: execIdx, candleTs: execCandle.time,
          data: {
            tradeTraceId: tid, direction: side,
            signalBarIndex: i, signalTimestamp: c.time, signalPrice: c.close,
            entryTimestamp: execCandle.time,
            requestedPrice: execCandle.open, executedPrice: fillPrice,
            executionModel: delayCandles === 0 && !strict
              ? "SAME_BAR_OPEN"  // signal close → same-bar open: see LOOKAHEAD_BIAS
              : delayCandles <= 1 ? "NEXT_BAR_OPEN" : `DELAYED_${delayCandles}_BARS`,
            quantity: amount, notional: invested,
            fee: feePaid, slippage: execCandle.open * slip * amount,
            spread: 0,
            partialFill: p.partialFill ? fillFactor : 1,
            balanceBefore, balanceAfter: balance,
            tpPrice, slPrice: effSl, liqPrice,
            atr: a ?? null,
            minOrderSize: "not modeled — exchange precision only enforced live",
            lookahead,
          },
        });
      }
    }
  }

  // force-close at last candle
  if (openPosition) {
    const last = p.candles[p.candles.length - 1];
    closePosition(openPosition, last.close, last, "END", p.candles.length - 1);
    openPosition = null;
  }

  tracer?.summary();
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
