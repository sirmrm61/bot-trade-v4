import type { Candle } from "@/modules/exchanges/types";
import { planGrid, gridStepPct, type GridConfig } from "@/modules/trading/grid";
import { diffQuotes, type DesiredQuote } from "@/modules/trading/market-making";
import { atr } from "@/modules/indicators/engine";
import { summarizeResult, type BacktestResult, type SimTrade } from "./engine";

interface RestingQuote extends DesiredQuote {
  id: number;
}

/**
 * Candle-based grid backtest — same mechanics as the MM sim:
 *   1. resting rungs fill when the candle range touches them
 *      (buy when low ≤ price, sell when high ≥ price and inventory covers)
 *   2. the ladder is replanned each candle; if close drifts beyond
 *      recenterPct from the anchor the whole grid rebuilds
 *   3. spacing is smart — max(cfg.stepPct, rolling ATR% × atrStepMult)
 * Realized PnL comes from FIFO matching sells against buy lots.
 */
export function runGridBacktest(p: {
  candles: Candle[];
  cfg: GridConfig;
  initialBalance: number;
  feePct: number;
  pricePrecision: number;
  amountPrecision: number;
  minAmount?: number | null;
}): BacktestResult {
  const feeRate = p.feePct / 100;
  let cash = p.initialBalance;
  let base = 0;
  let quotes: RestingQuote[] = [];
  let nextId = 1;
  let anchor: number | null = null;
  const lots: { price: number; amount: number; time: number }[] = [];
  const trades: SimTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];
  const atrVals = atr(p.candles, 14);

  const matchSell = (price: number, amount: number, t: number, exitReason: string) => {
    let remaining = amount;
    while (remaining > 1e-12 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.amount, remaining);
      const entryCost = take * lot.price * (1 + feeRate);
      const exitValue = take * price * (1 - feeRate);
      const pnl = exitValue - entryCost;
      trades.push({
        side: "BUY",
        entryPrice: lot.price, exitPrice: price, amount: take,
        fee: take * (lot.price + price) * feeRate,
        pnl, pnlPct: (pnl / entryCost) * 100,
        entryTime: lot.time, exitTime: t, exitReason,
      });
      lot.amount -= take;
      remaining -= take;
      if (lot.amount <= 1e-12) lots.shift();
    }
  };

  for (const [i, c] of p.candles.entries()) {
    // fills — resting rungs vs this candle's [low, high]
    const resting: RestingQuote[] = [];
    for (const q of quotes) {
      if (q.side === "BUY" && c.low <= q.price) {
        const cost = q.price * q.amount * (1 + feeRate);
        if (cash >= cost) {
          cash -= cost;
          base += q.amount;
          lots.push({ price: q.price, amount: q.amount, time: c.time });
          continue;
        }
      } else if (q.side === "SELL" && c.high >= q.price && base >= q.amount) {
        base -= q.amount;
        cash += q.price * q.amount * (1 - feeRate);
        matchSell(q.price, q.amount, c.time, "GRID_CYCLE");
        continue;
      }
      resting.push(q);
    }
    quotes = resting;

    // anchor lifecycle — init on first candle, recenter on band exit
    if (anchor === null) anchor = c.close;
    const rebuild = (Math.abs(c.close - anchor) / anchor) * 100 >= p.cfg.recenterPct;
    if (rebuild) {
      anchor = c.close;
      quotes = [];
    }

    const atrPct = Number.isFinite(atrVals[i]) ? (atrVals[i] / c.close) * 100 : null;
    const stepPct = gridStepPct(p.cfg, atrPct);

    const bidReserved = quotes.reduce((s, q) => (q.side === "BUY" ? s + q.price * q.amount : s), 0);
    const askReserved = quotes.reduce((s, q) => (q.side === "SELL" ? s + q.amount : s), 0);
    const desired = planGrid({
      anchor, stepPct, cfg: p.cfg,
      allocatedCapital: p.initialBalance,
      quoteFree: Math.max(0, cash - bidReserved),
      baseFree: Math.max(0, base - askReserved),
      baseTotal: base,
      mid: c.close,
      pricePrecision: p.pricePrecision,
      amountPrecision: p.amountPrecision,
      minAmount: p.minAmount,
    });
    const diff = diffQuotes(
      quotes.map((q) => ({ id: String(q.id), side: q.side, price: q.price })),
      desired,
      p.cfg.requotePct,
    );
    const kept = new Set(diff.keep);
    quotes = quotes.filter((q) => kept.has(String(q.id)));
    for (const q of diff.placements) quotes.push({ ...q, id: nextId++ });

    equityCurve.push({ t: c.time, equity: cash + base * c.close });
  }

  // liquidate remaining inventory at the last close
  if (base > 1e-12 && p.candles.length) {
    const last = p.candles[p.candles.length - 1];
    cash += base * last.close * (1 - feeRate);
    matchSell(last.close, base, last.time, "END");
    base = 0;
  }

  return summarizeResult(p.initialBalance, cash, trades, equityCurve);
}
