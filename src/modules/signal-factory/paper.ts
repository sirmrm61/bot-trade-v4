import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { journalWrite } from "@/modules/agent/journal";
import { getSetting } from "@/modules/settings/service";
import { tfMs } from "@/modules/pairs/service";
import { faNumber, faPercent, parseJson } from "@/shared/utils";
import { getCandles } from "./data";
import { transitionSetup } from "./lifecycle";
import { systemAgentId } from "./jobs";
import type { Candle } from "@/modules/exchanges/types";
import type { PaperTrade, Setup } from "@/generated/prisma/client";

/**
 * Paper trading — when an armed setup's trigger confirms, a PaperTrade opens
 * at the real trigger price with the SAME cost model as the backtest (real
 * exchange fee + slippage applied to every fill) so paper results stay
 * comparable to backtest verdicts. Management mirrors replaySetupRule:
 * TP1 banks 50% and moves the stop to breakeven; TP2 / SL / expiry close the
 * trade, set the setup's outcome + outcomePnlPct, and roll into SetupType
 * paper stats. Every event lands in the journal (PAPER_TRADE).
 */

export const PAPER_STAKE_QUOTE = 1000; // flat 10% of the 10k backtest baseline
const TP1_CLOSE_FRAC = 0.5;

interface PaperMeta {
  invested0: number;   // original stake — pnlPct basis after partials
  realizedPnl: number; // banked TP1 leg
  feePct: number;
  slippagePct: number;
  rawEntry: number;
}

const fillAt = (raw: number, long: boolean, slip: number) =>
  long ? raw * (1 - slip) : raw * (1 + slip); // exits
const legPnl = (long: boolean, amt: number, inv: number, entry: number, fill: number, fee: number) =>
  long ? amt * fill - amt * fill * fee - inv
       : (entry - fill) * amt - amt * fill * fee;

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export interface PaperDeps {
  feePct?: number;
  slippagePct?: number;
}

/** Open the paper trade for a confirmed setup — idempotent on setupId. */
export async function openPaperTrade(setup: Setup, deps: PaperDeps = {}): Promise<PaperTrade | null> {
  const existing = await prisma.paperTrade.findUnique({ where: { setupId: setup.id } });
  if (existing) return existing;

  const feePct = deps.feePct ?? (await getSetting<number>("BACKTEST_FEE_PCT"));
  const slippagePct = deps.slippagePct ?? (await getSetting<number>("BACKTEST_SLIPPAGE_PCT"));
  const long = setup.direction === "LONG";
  const slip = slippagePct / 100;
  const fill = long ? setup.triggerPrice * (1 + slip) : setup.triggerPrice * (1 - slip); // entry slippage
  const invested = PAPER_STAKE_QUOTE;
  const entryFee = invested * (feePct / 100);
  const amount = (invested - entryFee) / fill;

  const meta: PaperMeta = {
    invested0: invested, realizedPnl: 0, feePct, slippagePct, rawEntry: setup.triggerPrice,
  };
  const trade = await prisma.paperTrade.create({
    data: {
      setupId: setup.id, userId: setup.userId, symbol: setup.symbol,
      side: long ? "BUY" : "SELL",
      entryPrice: fill, amount, invested,
      tp1: setup.tp1, tp2: setup.tp2, sl: setup.sl,
      costsPct: 2 * (feePct + slippagePct),
      meta: JSON.stringify(meta),
    },
  });
  await transitionSetup(setup, "PAPER_OPEN",
    `تریگر ${faNumber(setup.triggerPrice, true)} تأیید شد — ورود پیپر ${long ? "لانگ" : "شورت"} در ${faNumber(fill, true)}`);
  await journalWrite(
    await systemAgentId(setup.userId), "PAPER_TRADE",
    `پیپر ${setup.symbol} ${long ? "لانگ" : "شورت"} باز شد @ ${faNumber(fill, true)} — SL ${faNumber(setup.sl, true)} · TP1 ${faNumber(setup.tp1, true)} · TP2 ${faNumber(setup.tp2, true)}`,
    { data: { setupId: setup.id, paperTradeId: trade.id, entryPrice: fill, invested, costsPct: trade.costsPct } },
  );
  return trade;
}

// ---------------------------------------------------------------------------
// Manage — same exit semantics as replaySetupRule
// ---------------------------------------------------------------------------

export type PaperEvent = "SL" | "TP1" | "TP2";

/** Ordered exit events one candle produces — SL wins any OHLC ambiguity. */
export function paperEvents(
  t: Pick<PaperTrade, "side" | "tp1" | "tp2" | "sl" | "tp1Hit">,
  c: Candle,
): PaperEvent[] {
  const long = t.side === "BUY";
  const hitSl = long ? c.low <= t.sl : c.high >= t.sl;
  if (hitSl) return ["SL"];
  const out: PaperEvent[] = [];
  if (!t.tp1Hit && (long ? c.high >= t.tp1 : c.low <= t.tp1)) out.push("TP1");
  if (long ? c.high >= t.tp2 : c.low <= t.tp2) out.push("TP2");
  return out;
}

const CLOSE_FA: Record<string, string> = {
  TP2_HIT: "هدف دوم زده شد",
  SL_HIT: "استاپ زده شد",
  EXPIRED: "انقضای ستاپ — بستن در قیمت فعلی",
};

async function closePaper(
  trade: PaperTrade,
  setup: Setup,
  meta: PaperMeta,
  raw: number,
  exitReason: "TP2_HIT" | "SL_HIT" | "EXPIRED",
): Promise<void> {
  const long = trade.side === "BUY";
  const fee = meta.feePct / 100;
  const fill = fillAt(raw, long, meta.slippagePct / 100);
  const leg = legPnl(long, trade.amount, trade.invested, trade.entryPrice, fill, fee);
  const pnl = meta.realizedPnl + leg;
  const pnlPct = meta.invested0 > 0 ? (pnl / meta.invested0) * 100 : 0;
  // a breakeven/expiry close after banking TP1 still counts as TP1_HIT
  const outcome = exitReason === "TP2_HIT" ? "TP2_HIT" : trade.tp1Hit ? "TP1_HIT" : exitReason;

  await prisma.paperTrade.update({
    where: { id: trade.id },
    data: {
      status: "CLOSED", exitPrice: fill, exitReason, pnl, pnlPct,
      closedAt: new Date(), meta: JSON.stringify({ ...meta, realizedPnl: pnl }),
    },
  });
  await transitionSetup(setup, "PAPER_CLOSED",
    `${CLOSE_FA[exitReason]} — نتیجه‌ی پیپر ${faPercent(pnlPct)}`,
    { patch: { outcome, outcomePnlPct: pnlPct }, data: { paperTradeId: trade.id, exitPrice: fill, exitReason } });
  await journalWrite(
    await systemAgentId(setup.userId), "PAPER_TRADE",
    `پیپر ${trade.symbol} بسته شد — ${CLOSE_FA[exitReason]} @ ${faNumber(fill, true)} · نتیجه ${faPercent(pnlPct)}`,
    { data: { setupId: setup.id, paperTradeId: trade.id, outcome, pnl, pnlPct } },
  );

  // roll into pattern stats — same running-mean shape as the backtest rollup
  const type = await prisma.setupType.findUnique({ where: { key: setup.typeKey } });
  const paperTrades = (type?.paperTrades ?? 0) + 1;
  const paperExpectancy =
    ((type?.paperExpectancy ?? 0) * (type?.paperTrades ?? 0) + pnlPct) / paperTrades;
  await prisma.setupType.upsert({
    where: { key: setup.typeKey },
    create: { key: setup.typeKey, kind: setup.kind, paramsHash: setup.typeKey.split(":")[1] ?? "", paperTrades: 1, paperExpectancy: pnlPct },
    update: { paperTrades, paperExpectancy },
  });
}

/**
 * One candle's worth of management on an open paper trade. Returns CLOSED
 * once the trade exits (TP2 / SL / expiry at candle close past expiresAt).
 */
export async function managePaperTrade(
  trade: PaperTrade,
  setup: Setup,
  candle: Candle,
  now = Date.now(),
): Promise<"OPEN" | "CLOSED"> {
  const meta = parseJson<PaperMeta>(trade.meta, {
    invested0: trade.invested, realizedPnl: 0, feePct: 0, slippagePct: 0, rawEntry: trade.entryPrice,
  });
  const long = trade.side === "BUY";
  const slip = meta.slippagePct / 100;
  const fee = meta.feePct / 100;

  for (const ev of paperEvents(trade, candle)) {
    if (ev === "TP1") {
      const amt = trade.amount * TP1_CLOSE_FRAC;
      const inv = trade.invested * TP1_CLOSE_FRAC;
      const fill = fillAt(trade.tp1, long, slip);
      const leg = legPnl(long, amt, inv, trade.entryPrice, fill, fee);
      meta.realizedPnl += leg;
      trade = await prisma.paperTrade.update({
        where: { id: trade.id },
        data: {
          amount: trade.amount - amt,
          invested: trade.invested - inv,
          tp1Hit: true,
          sl: trade.entryPrice, // runner → breakeven
          meta: JSON.stringify(meta),
        },
      });
      await journalWrite(
        await systemAgentId(setup.userId), "PAPER_TRADE",
        `TP1 پیپر ${trade.symbol} زده شد — ۵۰٪ با ${faPercent(leg / Math.max(inv, 1e-9) * 100)} بانک شد، استاپ به نقطه‌ی ورود منتقل شد`,
        { data: { setupId: setup.id, paperTradeId: trade.id, tp1: trade.tp1, legPnl: leg } },
      );
      continue;
    }
    await closePaper(trade, setup, meta, ev === "TP2" ? trade.tp2 : trade.sl,
      ev === "TP2" ? "TP2_HIT" : "SL_HIT");
    return "CLOSED";
  }

  if (now > setup.expiresAt.getTime()) {
    await closePaper(trade, setup, meta, candle.close, "EXPIRED");
    return "CLOSED";
  }
  return "OPEN";
}

// ---------------------------------------------------------------------------
// paper-position-manager body (1 min)
// ---------------------------------------------------------------------------

export interface ManagerDeps {
  fetchCandles?: (exchange: string, symbol: string, timeframe: string) => Promise<Candle[]>;
  now?: number;
}

export async function runPaperManager(deps: ManagerDeps = {}): Promise<{
  managed: number; closed: number; failed: number;
}> {
  const now = deps.now ?? Date.now();
  const fetchCandles = deps.fetchCandles ?? ((e, s, tf) => getCandles(e, s, tf, 5));
  const open = await prisma.paperTrade.findMany({
    where: { status: "OPEN" },
    include: { setup: true },
  });
  const out = { managed: 0, closed: 0, failed: 0 };
  const candleCache = new Map<string, Promise<Candle[]>>();

  for (const trade of open) {
    const setup = trade.setup;
    try {
      const k = `${setup.exchange}|${setup.symbol}|${setup.timeframe}`;
      if (!candleCache.has(k)) {
        candleCache.set(k, fetchCandles(setup.exchange, setup.symbol, setup.timeframe));
      }
      const all = await candleCache.get(k)!;
      // candles still open at entry carry post-entry prices — evaluate those,
      // plus anything closed since (covers missed ticks), newest 3
      const ms = tfMs(setup.timeframe);
      const sinceEntry = all.filter((c) => c.time + ms > trade.openedAt.getTime());
      const candles = (sinceEntry.length ? sinceEntry : all).slice(-3);

      let cur: PaperTrade = trade;
      let status: "OPEN" | "CLOSED" = "OPEN";
      for (const c of candles) {
        status = await managePaperTrade(cur, setup, c, now);
        if (status === "CLOSED") break;
        cur = await prisma.paperTrade.findUniqueOrThrow({ where: { id: trade.id } });
      }
      out.managed++;
      if (status === "CLOSED") out.closed++;
    } catch (e) {
      out.failed++;
      logger.warn("paper manager step failed", {
        module: "signal-factory", paperTradeId: trade.id, symbol: trade.symbol,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return out;
}
