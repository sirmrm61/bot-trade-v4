import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { atr } from "@/modules/indicators/engine";
import { getSetting } from "@/modules/settings/service";
import { journalWrite } from "@/modules/agent/journal";
import { summarizeResult, type BacktestResult, type SimTrade } from "@/modules/backtest/engine";
import { acceptanceCheck, extendedMetrics, ACCEPTANCE, type ExtendedMetrics } from "@/modules/backtest/metrics";
import { tfMs } from "@/modules/pairs/service";
import { parseJson } from "@/shared/utils";
import { getCandles, dataFresh } from "./data";
import { candidateSymbols } from "./setups";
import { systemAgentId } from "./jobs";
import type { Candle } from "@/modules/exchanges/types";
import type { Setup } from "@/generated/prisma/client";

/**
 * Setup backtester — replays a setup's RULE (trigger + confirm + levels) over
 * historical candles with strict causality: confirm on a candle's close, entry
 * at the NEXT candle's open. Exits: first TP1 touch banks 50% and moves the
 * stop to breakeven, the runner exits on TP2 / SL / expiry. A candle touching
 * both SL and a pending target resolves to SL (conservative, like
 * backtestScanner). Costs = real exchange fee (BACKTEST_FEE_PCT) + slippage
 * (BACKTEST_SLIPPAGE_PCT).
 *
 * Verdicts are pooled over the setup's own symbol + the 2 most similar
 * symbols (nearest ATR% on the same exchange/timeframe): ≥30 trades and a
 * passing acceptanceCheck → VERIFIED; fewer → INSUFFICIENT; otherwise an
 * honest REJECTED.
 */

export type BacktestLabel = "NOT_TESTED" | "VERIFIED" | "INSUFFICIENT" | "REJECTED";
export const VERDICT_FA: Record<Exclude<BacktestLabel, "NOT_TESTED">, string> = {
  VERIFIED: "تأییدشده",
  INSUFFICIENT: "ناکافی",
  REJECTED: "رد‌شده",
};

const MIN_CANDLES = 40;
const BT_CANDLE_LIMIT = 300;
const POSITION_FRACTION = 0.1;   // flat 10% of initial balance per occurrence
const TP1_CLOSE_FRAC = 0.5;
const PEER_COUNT = 2;
const PEER_CANDIDATES = 8;
const SWEEP_LIMIT = 20;
export const COMBINED_SYMBOL = "COMBINED";

// ---------------------------------------------------------------------------
// Pure rule replay — testable, no DB
// ---------------------------------------------------------------------------

export interface SetupRule {
  direction: "LONG" | "SHORT";
  confirmRule: string; // CLOSE_ABOVE_TF | CLOSE_BELOW_TF | CLOSE_IN_ZONE_BULL_TF | CLOSE_IN_ZONE_BEAR_TF
  triggerPrice: number;
  entryLow: number;
  entryHigh: number;
  tp1: number;
  tp2: number;
  sl: number;
  horizonCandles: number; // expiry window in candles
}

export function ruleConfirmed(rule: SetupRule, c: Candle): boolean {
  switch (rule.confirmRule) {
    case "CLOSE_ABOVE_TF": return c.close > rule.triggerPrice;
    case "CLOSE_BELOW_TF": return c.close < rule.triggerPrice;
    case "CLOSE_IN_ZONE_BULL_TF":
      return c.close >= rule.entryLow && c.close <= rule.entryHigh && c.close > c.open;
    case "CLOSE_IN_ZONE_BEAR_TF":
      return c.close >= rule.entryLow && c.close <= rule.entryHigh && c.close < c.open;
    default: return false;
  }
}

interface ReplayOpts {
  feePct: number;
  slippagePct: number;
  initialBalance: number;
}

interface SimPos {
  entryPrice: number;   // fill incl. slippage
  rawEntry: number;
  entryIdx: number;
  amount: number;
  invested: number;     // remaining margin/cost basis backing the open amount
  sl: number;
  tp1Done: boolean;
}

export function replaySetupRule(
  rule: SetupRule,
  candles: Candle[],
  opts: ReplayOpts,
): { trades: SimTrade[]; equityCurve: { t: number; equity: number }[] } {
  const long = rule.direction === "LONG";
  const fee = opts.feePct / 100;
  const slip = opts.slippagePct / 100;
  const horizon = Math.max(1, Math.floor(rule.horizonCandles));
  const stake = opts.initialBalance * POSITION_FRACTION;

  let balance = opts.initialBalance;
  let pos: SimPos | null = null;
  let wasConfirm = false;
  const trades: SimTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];

  const unrealized = (p: SimPos, price: number) =>
    long ? (price - p.entryPrice) * p.amount : (p.entryPrice - price) * p.amount;
  // spot long: equity = cash + position value; short (margin): cash + margin ± pnl
  const equityAt = (p: SimPos | null, price: number) =>
    !p ? balance : balance + (long ? p.amount * price : p.invested + unrealized(p, price));

  /** close `amt`/`inv` of the position at raw price, book the SimTrade */
  const bookExit = (p: SimPos, amt: number, inv: number, raw: number, c: Candle, exitReason: string, exitIdx: number) => {
    const fill = long ? raw * (1 - slip) : raw * (1 + slip);
    const exitFee = amt * fill * fee;
    const pnl = long ? amt * fill - exitFee - inv : (p.entryPrice - fill) * amt - exitFee;
    balance += long ? amt * fill - exitFee : inv + pnl;
    trades.push({
      side: long ? "BUY" : "SELL",
      entryPrice: p.entryPrice, exitPrice: fill, amount: amt, fee: exitFee,
      pnl, pnlPct: inv > 0 ? (pnl / inv) * 100 : 0,
      entryTime: candles[p.entryIdx].time, exitTime: c.time, exitReason,
      rawEntryPrice: p.rawEntry, rawExitPrice: raw,
    });
    p.amount -= amt;
    p.invested -= inv;
    return pnl;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    equityCurve.push({ t: c.time, equity: equityAt(pos, c.close) });

    if (pos) {
      const p = pos;
      const hitSl = long ? c.low <= p.sl : c.high >= p.sl;
      const hitTp1 = !p.tp1Done && (long ? c.high >= rule.tp1 : c.low <= rule.tp1);
      const hitTp2 = long ? c.high >= rule.tp2 : c.low <= rule.tp2;

      if (hitSl && (hitTp1 || hitTp2)) {
        // one candle covers SL and a target — OHLC can't order them; resolve to SL
        bookExit(p, p.amount, p.invested, p.sl, c, "SL_HIT", i);
        pos = null;
      } else if (hitSl) {
        bookExit(p, p.amount, p.invested, p.sl, c, "SL_HIT", i);
        pos = null;
      } else {
        if (hitTp1) {
          bookExit(p, p.amount * TP1_CLOSE_FRAC, p.invested * TP1_CLOSE_FRAC, rule.tp1, c, "PARTIAL_TP", i);
          p.tp1Done = true;
          p.sl = p.entryPrice; // breakeven on the runner
        }
        if (hitTp2) {
          bookExit(p, p.amount, p.invested, rule.tp2, c, "TP2_HIT", i);
          pos = null;
        } else if (i - p.entryIdx + 1 >= horizon) {
          bookExit(p, p.amount, p.invested, c.close, c, "EXPIRED", i);
          pos = null;
        }
      }
    }

    const conf = ruleConfirmed(rule, c);
    if (!pos && conf && !wasConfirm) {
      const j = i + 1;
      if (j >= candles.length) break;
      const ec = candles[j];
      const fill = long ? ec.open * (1 + slip) : ec.open * (1 - slip);
      const invested = Math.min(stake, balance);
      if (invested > 0) {
        const entryFee = invested * fee;
        balance -= invested;
        pos = {
          entryPrice: fill, rawEntry: ec.open, entryIdx: j,
          amount: (invested - entryFee) / fill, invested,
          sl: rule.sl, tp1Done: false,
        };
      }
    }
    wasConfirm = conf;
  }

  if (pos) {
    const last = candles[candles.length - 1];
    bookExit(pos, pos.amount, pos.invested, last.close, last, "END", candles.length - 1);
  }
  return { trades, equityCurve };
}

// ---------------------------------------------------------------------------
// Metrics plumbing — time-ordered 70/30 split into extendedMetrics
// ---------------------------------------------------------------------------

export function splitTrainTest(trades: SimTrade[], frac = 0.7): { train: SimTrade[]; test: SimTrade[] } {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const cut = Math.min(Math.max(1, Math.floor(sorted.length * frac)), Math.max(sorted.length - 1, 1));
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

export function tradesToResult(trades: SimTrade[], initialBalance: number): BacktestResult {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let bal = initialBalance;
  const curve = sorted.map((t) => ({ t: t.exitTime, equity: (bal += t.pnl) }));
  if (!curve.length) curve.push({ t: 0, equity: initialBalance });
  return summarizeResult(initialBalance, bal, sorted, curve);
}

export interface Verdict {
  label: Exclude<BacktestLabel, "NOT_TESTED">;
  reasons: string[];
  train: ExtendedMetrics;
  test: ExtendedMetrics;
  totalTrades: number;
  wins: number;
}

export function judgeVerdict(trades: SimTrade[], initialBalance = 10_000): Verdict {
  const { train, test } = splitTrainTest(trades);
  const mTrain = extendedMetrics(tradesToResult(train, initialBalance));
  const mTest = extendedMetrics(tradesToResult(test, initialBalance));
  const acc = acceptanceCheck(mTrain, mTest);
  const total = train.length + test.length;
  const label: Verdict["label"] =
    total < ACCEPTANCE.MIN_TRADES ? "INSUFFICIENT" : acc.passed ? "VERIFIED" : "REJECTED";
  return {
    label, reasons: acc.reasons, train: mTrain, test: mTest,
    totalTrades: total, wins: trades.filter((t) => t.pnl > 0).length,
  };
}

// ---------------------------------------------------------------------------
// Peer selection — 2 symbols with the closest volatility (ATR%) on the same
// exchange/timeframe, out of the config's liquid candidates
// ---------------------------------------------------------------------------

function atrPctOf(candles: Candle[]): number {
  const a = atr(candles, 14).at(-1);
  const price = candles.at(-1)?.close ?? 0;
  return Number.isFinite(a) && price > 0 ? ((a ?? 0) / price) * 100 : NaN;
}

async function similarSymbols(
  setup: Setup,
  targetAtrPct: number,
  fetchCandles: (symbol: string) => Promise<Candle[]>,
): Promise<string[]> {
  const cfg = await prisma.signalMakerConfig.findUnique({ where: { id: setup.configId } });
  const picks = { exchange: setup.exchange, marketType: setup.marketType, quote: cfg?.quote ?? "USDT", minVolume24h: cfg?.minVolume24h ?? 0 };
  const candidates = (await candidateSymbols(picks)).filter((s) => s !== setup.symbol).slice(0, PEER_CANDIDATES);
  const scored: { symbol: string; dist: number }[] = [];
  for (const symbol of candidates) {
    try {
      const cs = await fetchCandles(symbol);
      const pct = atrPctOf(cs);
      if (Number.isFinite(pct) && Number.isFinite(targetAtrPct)) scored.push({ symbol, dist: Math.abs(pct - targetAtrPct) });
    } catch { /* peer data failed — skip */ }
  }
  return scored.sort((a, b) => a.dist - b.dist).slice(0, PEER_COUNT).map((s) => s.symbol);
}

// ---------------------------------------------------------------------------
// Orchestration — replay + rows + rollup + journal
// ---------------------------------------------------------------------------

export interface BacktestDeps {
  fetchCandles?: (symbol: string) => Promise<Candle[]>;
  peers?: string[];
  feePct?: number;
  slippagePct?: number;
}

export async function backtestSetup(setup: Setup, deps: BacktestDeps = {}): Promise<Verdict | null> {
  const fetchCandles =
    deps.fetchCandles ?? ((symbol: string) => getCandles(setup.exchange, symbol, setup.timeframe, BT_CANDLE_LIMIT));
  const feePct = deps.feePct ?? (await getSetting<number>("BACKTEST_FEE_PCT"));
  const slippagePct = deps.slippagePct ?? (await getSetting<number>("BACKTEST_SLIPPAGE_PCT"));
  const horizonCandles = Math.max(
    1, Math.round((setup.expiresAt.getTime() - setup.createdAt.getTime()) / tfMs(setup.timeframe)),
  );
  const rule: SetupRule = {
    direction: setup.direction === "SHORT" ? "SHORT" : "LONG",
    confirmRule: setup.confirmRule, triggerPrice: setup.triggerPrice,
    entryLow: setup.entryLow, entryHigh: setup.entryHigh,
    tp1: setup.tp1, tp2: setup.tp2, sl: setup.sl, horizonCandles,
  };
  const replayOpts: ReplayOpts = { feePct, slippagePct, initialBalance: 10_000 };

  const candles = await fetchCandles(setup.symbol);
  if (candles.length < MIN_CANDLES) {
    logger.warn("setup backtest skipped — too few candles", { module: "signal-factory", symbol: setup.symbol });
    return null;
  }
  const peers = deps.peers ?? (await similarSymbols(setup, atrPctOf(candles), fetchCandles));
  const symbols = [setup.symbol, ...peers];

  const allTrades: SimTrade[] = [];
  const rows: { symbol: string; trades: SimTrade[]; first: number; last: number }[] = [];
  for (const symbol of symbols) {
    try {
      const cs = symbol === setup.symbol ? candles : await fetchCandles(symbol);
      if (cs.length < MIN_CANDLES) continue;
      const { trades } = replaySetupRule(rule, cs, replayOpts);
      rows.push({ symbol, trades, first: cs[0].time, last: cs.at(-1)!.time });
      allTrades.push(...trades);
    } catch (e) {
      logger.warn("peer replay failed", { module: "signal-factory", symbol, errorCode: String(e).slice(0, 120) });
    }
  }

  const verdict = judgeVerdict(allTrades);
  const perSymbol = rows.map((r) => {
    const { train, test } = splitTrainTest(r.trades);
    const mTrain = extendedMetrics(tradesToResult(train, replayOpts.initialBalance));
    const mTest = extendedMetrics(tradesToResult(test, replayOpts.initialBalance));
    const acc = acceptanceCheck(mTrain, mTest);
    return { ...r, mTrain, mTest, acc };
  });

  await prisma.$transaction([
    ...perSymbol.map((r) =>
      prisma.setupBacktest.create({
        data: {
          setupId: setup.id, typeKey: setup.typeKey, symbol: r.symbol, timeframe: setup.timeframe,
          startDate: new Date(r.first), endDate: new Date(r.last),
          feePct, slippagePct,
          trainMetrics: JSON.stringify(r.mTrain), testMetrics: JSON.stringify(r.mTest),
          passed: r.acc.passed, reasons: JSON.stringify(r.acc.reasons),
        },
      }),
    ),
    prisma.setupBacktest.create({
      data: {
        setupId: setup.id, typeKey: setup.typeKey, symbol: COMBINED_SYMBOL, timeframe: setup.timeframe,
        startDate: new Date(Math.min(...rows.map((r) => r.first))),
        endDate: new Date(Math.max(...rows.map((r) => r.last))),
        feePct, slippagePct,
        trainMetrics: JSON.stringify(verdict.train), testMetrics: JSON.stringify(verdict.test),
        passed: verdict.label === "VERIFIED", reasons: JSON.stringify(verdict.reasons),
      },
    }),
    prisma.setup.update({
      where: { id: setup.id },
      data: {
        backtestLabel: verdict.label,
        ...(verdict.label === "VERIFIED" ? { state: "BACKTESTED" } : {}),
        ...(verdict.label === "REJECTED" ? { state: "REJECTED", closedAt: new Date() } : {}),
      },
    }),
  ]);

  // roll the outcome into the pattern stats — samples/wins accumulate,
  // expectancy is a running mean, PF/DD track the latest pooled verdict.
  // Infinity PF (no losing trade) stores as null — SQLite/JSON can't hold it.
  const finite = (v: number) => (Number.isFinite(v) ? v : null);
  const pnlSum = allTrades.reduce((s, t) => s + t.pnlPct, 0);
  const existing = await prisma.setupType.findUnique({ where: { key: setup.typeKey } });
  const samples = (existing?.samples ?? 0) + verdict.totalTrades;
  const expectancy = samples > 0
    ? ((existing?.expectancy ?? 0) * (existing?.samples ?? 0) + pnlSum) / samples : 0;
  await prisma.setupType.upsert({
    where: { key: setup.typeKey },
    create: {
      key: setup.typeKey, kind: setup.kind, paramsHash: setup.typeKey.split(":")[1] ?? "",
      samples: verdict.totalTrades, wins: verdict.wins, expectancy,
      pfTrain: finite(verdict.train.profitFactor), pfTest: finite(verdict.test.profitFactor),
      maxDD: Math.max(verdict.train.maxDrawdownPct, verdict.test.maxDrawdownPct),
    },
    update: {
      samples, wins: (existing?.wins ?? 0) + verdict.wins, expectancy,
      pfTrain: finite(verdict.train.profitFactor), pfTest: finite(verdict.test.profitFactor),
      maxDD: Math.max(verdict.train.maxDrawdownPct, verdict.test.maxDrawdownPct),
    },
  });

  await journalWrite(
    await systemAgentId(setup.userId), "BACKTEST",
    `بک‌تست الگوی ${setup.kind} روی ${setup.symbol} (+${peers.length} جفت مشابه): «${VERDICT_FA[verdict.label]}» — ${verdict.totalTrades} معامله`,
    {
      reason: verdict.reasons.length ? verdict.reasons.join("؛ ") : undefined,
      data: {
        typeKey: setup.typeKey, symbols,
        pfTrain: verdict.train.profitFactor, pfTest: verdict.test.profitFactor,
        expectancy: verdict.test.expectancy,
        maxDD: Math.max(verdict.train.maxDrawdownPct, verdict.test.maxDrawdownPct),
      },
    },
  );
  return verdict;
}

/** Latest pooled verdict reasons for a set of setup ids (page display). */
export async function rejectionReasons(setupIds: string[]): Promise<Map<string, string[]>> {
  if (!setupIds.length) return new Map();
  const rows = await prisma.setupBacktest.findMany({
    where: { setupId: { in: setupIds }, symbol: COMBINED_SYMBOL },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    if (r.setupId && !map.has(r.setupId)) map.set(r.setupId, parseJson<string[]>(r.reasons, []));
  }
  return map;
}

/** Backtest-runner body — every setup still carrying NOT_TESTED. */
export async function runBacktestSweep(opts: { limit?: number } = {}): Promise<{
  tested: number; verified: number; insufficient: number; rejected: number; failed: number; skipped: number;
}> {
  const pending = await prisma.setup.findMany({
    where: { backtestLabel: "NOT_TESTED", state: { in: ["PROPOSED", "BACKTESTED"] } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? SWEEP_LIMIT,
  });
  const out = { tested: 0, verified: 0, insufficient: 0, rejected: 0, failed: 0, skipped: 0 };
  for (const setup of pending) {
    if (!dataFresh(setup.exchange)) { out.skipped++; continue; }
    try {
      const v = await backtestSetup(setup);
      if (!v) { out.skipped++; continue; }
      out.tested++;
      if (v.label === "VERIFIED") out.verified++;
      else if (v.label === "REJECTED") out.rejected++;
      else out.insufficient++;
    } catch (e) {
      out.failed++;
      logger.warn("setup backtest failed", {
        module: "signal-factory", setupId: setup.id, symbol: setup.symbol,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return out;
}
