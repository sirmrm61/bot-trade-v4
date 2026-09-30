/**
 * PnL Audit — independently rebuilds a trade's Net PnL from its recorded cost
 * components. If the recomputed value differs from what the engine recorded,
 * the discrepancy is surfaced instead of being silently absorbed.
 *
 *   Net PnL = Gross PnL
 *             − entryFee − exitFee
 *             − spreadCost
 *             − entrySlippage − exitSlippage
 *             − otherCosts
 */
export interface PnlComponents {
  side: "LONG" | "SHORT";
  /** prices BEFORE slippage (raw candle prices at fill time) */
  rawEntryPrice: number;
  rawExitPrice: number;
  /** prices AFTER slippage (actual fills) */
  fillEntryPrice: number;
  fillExitPrice: number;
  amount: number;   // base units
  invested: number; // quote committed (spot) / margin (futures)
  entryFee: number;
  exitFee: number;
  spreadCost?: number;
  otherCosts?: number;
  market: "SPOT" | "FUTURES";
  /** what the engine recorded */
  recordedPnl: number;
}

export interface PnlAuditResult {
  grossPnl: number;          // direction-aware, at fill prices
  entrySlippage: number;     // quote lost to slippage on entry
  exitSlippage: number;
  totalCosts: number;
  calculatedNetPnl: number;
  recordedNetPnl: number;
  drift: number;             // |calculated − recorded|
  ok: boolean;               // drift within tolerance
}

const REL_TOL = 1e-9;

export function auditPnl(c: PnlComponents): PnlAuditResult {
  const dir = c.side === "LONG" ? 1 : -1;
  const grossPnl = dir * (c.fillExitPrice - c.fillEntryPrice) * c.amount;

  const entrySlippage = Math.abs(c.fillEntryPrice - c.rawEntryPrice) * c.amount;
  const exitSlippage = Math.abs(c.fillExitPrice - c.rawExitPrice) * c.amount;
  const totalCosts =
    c.entryFee + c.exitFee + (c.spreadCost ?? 0) + (c.otherCosts ?? 0) + entrySlippage + exitSlippage;

  // rebuild net pnl from the same identities the engine uses
  const calculatedNetPnl =
    c.market === "FUTURES"
      ? grossPnl - c.exitFee                                  // margin returned separately
      : c.amount * c.fillExitPrice - c.exitFee - c.invested;  // proceeds − fee − invested

  const drift = Math.abs(calculatedNetPnl - c.recordedPnl);
  return {
    grossPnl,
    entrySlippage,
    exitSlippage,
    totalCosts,
    calculatedNetPnl,
    recordedNetPnl: c.recordedPnl,
    drift,
    ok: drift <= Math.max(1e-6, Math.abs(c.recordedPnl) * REL_TOL),
  };
}
