import type { Candle } from "@/modules/exchanges/types";
import { planQuotes, diffQuotes, type MmConfig, type DesiredQuote } from "@/modules/trading/market-making";
import { summarizeResult, type BacktestResult, type SimTrade } from "./engine";

interface RestingQuote extends DesiredQuote {
  id: number;
}

/**
 * Candle-based market-making backtest — historical order books don't exist,
 * so each candle stands in for one quoting cycle:
 *   1. resting quotes fill if the candle's range touches them
 *      (bid fills when low <= bidPrice, ask when high >= askPrice)
 *   2. quotes are replanned around the candle close with the same
 *      planQuotes/diffQuotes used live
 * Realized PnL comes from FIFO matching of sell fills against buy lots.
 */
export function runMmBacktest(p: {
  candles: Candle[];
  cfg: MmConfig;
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
  const lots: { price: number; amount: number; time: number }[] = [];
  const trades: SimTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];

  // FIFO match a sell fill against open buy lots → realized SimTrades
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
        entryPrice: lot.price,
        exitPrice: price,
        amount: take,
        fee: take * (lot.price + price) * feeRate,
        pnl,
        pnlPct: (pnl / entryCost) * 100,
        entryTime: lot.time,
        exitTime: t,
        exitReason,
      });
      lot.amount -= take;
      remaining -= take;
      if (lot.amount <= 1e-12) lots.shift();
    }
  };

  for (const c of p.candles) {
    // fills — resting quotes vs this candle's [low, high]
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
        matchSell(q.price, q.amount, c.time, "MM_CYCLE");
        continue;
      }
      resting.push(q);
    }
    quotes = resting;

    // replan — free balances exclude capital locked in resting quotes
    const bidReserved = quotes.reduce((s, q) => (q.side === "BUY" ? s + q.price * q.amount : s), 0);
    const askReserved = quotes.reduce((s, q) => (q.side === "SELL" ? s + q.amount : s), 0);
    const desired = planQuotes({
      mid: c.close,
      cfg: p.cfg,
      allocatedCapital: p.initialBalance,
      quoteFree: Math.max(0, cash - bidReserved),
      baseFree: Math.max(0, base - askReserved),
      baseTotal: base,
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
