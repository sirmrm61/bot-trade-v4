import { prisma } from "@/infrastructure/database/prisma";

/**
 * SignalLog — the ML dataset backbone.
 *
 * Every entry decision the live engine evaluates gets one row: the raw
 * signal, its score, and a JSON snapshot of the features that produced it
 * (indicator breakdown / symbolic x+context / OBI state). When the trade
 * that resulted from a logged entry closes, its realized pnlPct is
 * backfilled — giving a clean (features → outcome) supervised dataset.
 *
 * Logging must NEVER break the trading loop — every write is fire-and-
 * forget and swallowed on error.
 */

export type SignalDecision =
  | "ENTERED"            // trade opened from this signal
  | "VETO_SMART"         // smart layer vetoed the entry
  | "SKIP_SPOT_SHORT"    // SELL signal on a spot market
  | "SKIP_OPEN_POSITION" // an open position already exists
  | "SKIP_OPEN_ORDER";   // an open order already exists

export interface SignalLogInput {
  liveStrategyId: string;
  userId: string;
  exchange: string;
  symbol: string;
  kind: string;
  signal: "BUY" | "SELL";
  score?: number;
  side?: "LONG" | "SHORT" | null;
  decision: SignalDecision;
  features: Record<string, unknown>;
  context?: string;
  tradeId?: string;
}

/**
 * Episode dedupe — while a signal stays above threshold it is ONE episode.
 * Log the first tick of the episode (or any actual entry), skip repeats.
 * `sigEp` in live stats carries the last logged signal; HOLD clears it.
 */
export function shouldLogEpisode(
  prevEpisode: string | null | undefined,
  rawSignal: "BUY" | "SELL" | "HOLD",
  force: boolean,
): boolean {
  if (rawSignal === "HOLD") return false;
  return force || prevEpisode !== rawSignal;
}

export async function logSignal(input: SignalLogInput): Promise<void> {
  try {
    await prisma.signalLog.create({
      data: {
        liveStrategyId: input.liveStrategyId,
        userId: input.userId,
        exchange: input.exchange,
        symbol: input.symbol,
        kind: input.kind,
        signal: input.signal,
        score: input.score ?? null,
        side: input.side ?? null,
        decision: input.decision,
        features: JSON.stringify(input.features),
        context: input.context ?? null,
        tradeId: input.tradeId ?? null,
      },
    });
  } catch {
    // analytics writes never break trading
  }
}

/** Backfill the realized outcome onto the signal rows that opened a trade. */
export async function attachTradeOutcome(
  tradeId: string,
  pnlPct: number,
  exitReason: string,
): Promise<void> {
  try {
    await prisma.signalLog.updateMany({
      where: { tradeId, outcomePnlPct: null },
      data: { outcomePnlPct: pnlPct, outcomeReason: exitReason },
    });
  } catch {
    // best-effort
  }
}
