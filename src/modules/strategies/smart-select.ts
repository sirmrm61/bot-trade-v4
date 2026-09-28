import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { TIMEFRAMES } from "@/shared/constants";
import { INDICATORS } from "@/modules/indicators/registry";
import {
  computeIndicator, evaluateCondition, defaultScore,
  type Condition, type IndicatorSeries, type IndicatorParams,
} from "@/modules/indicators/engine";
import { getCandles } from "@/modules/pairs/service";
import { runBacktest } from "@/modules/backtest/engine";
import { runAndPersist } from "@/modules/backtest/service";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";
import { createStrategy, type StrategyInput } from "./service";
import { getSetting } from "@/modules/settings/service";
import { notify } from "@/modules/notifications/service";
import { logActivity } from "@/modules/activity/service";
import { logger } from "@/infrastructure/logging/logger";

/**
 * Smart Select (admin-only) — searches the indicator space automatically.
 *
 * Each indicator VARIANT (same indicator, different parameters — e.g.
 * SMA(5) vs SMA(15)) is treated as an independent unit that can be combined
 * with any other unit, including other variants of the same indicator.
 *
 *   Phase A: every unit's score series is computed once, then each candidate
 *            (singles + pairs) is screened by counting BUY/SELL signals —
 *            O(n) per candidate, no full simulation.
 *   Phase B: a real backtest runs for the top-signal candidates.
 *   Winner:  highest profitPct — and it MUST be positive. Signals break ties.
 *            If nothing is profitable, no strategy is created.
 */

const BUY_THRESHOLD = 0.35;
const SELL_THRESHOLD = -0.35;
const TOP_BACKTEST_COUNT = 10;
const LEADERBOARD_SIZE = 12;
const WARMUP = 60;

/** Parameter variants — each is an independent unit in the candidate space. */
const PARAM_VARIANTS: Record<string, IndicatorParams[]> = {
  RSI: [{ period: 7 }, { period: 14 }],
  EMA: [{ period: 9 }, { period: 21 }, { period: 50 }],
  SMA: [{ period: 5 }, { period: 15 }, { period: 20 }, { period: 50 }],
  MACD: [
    { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    { fastPeriod: 5, slowPeriod: 13, signalPeriod: 1 },
    { fastPeriod: 8, slowPeriod: 21, signalPeriod: 5 },
  ],
  BOLLINGER: [{ period: 20, stdDev: 2 }, { period: 10, stdDev: 1.5 }],
  VWAP: [{}],
  STOCHASTIC: [
    { kPeriod: 5, dPeriod: 3, smoothing: 3 },
    { kPeriod: 14, dPeriod: 3, smoothing: 3 },
  ],
  OBV: [{ period: 20 }],
};

function variantLabel(key: string, p: IndicatorParams): string {
  const vals = Object.values(p).join(",");
  return vals ? `${key}(${vals})` : key;
}

interface Unit {
  label: string;
  name: string;
  parameters: IndicatorParams;
  buyCond?: Condition;
  sellCond?: Condition;
}

function buildUnits(): Unit[] {
  const units: Unit[] = [];
  for (const def of INDICATORS.filter((d) => d.scoring)) {
    const variants = PARAM_VARIANTS[def.key] ?? [def.defaultParams];
    for (const p of variants) {
      units.push({
        label: variantLabel(def.key, p),
        name: def.key,
        parameters: p,
        buyCond: def.defaultBuyCondition as Condition | undefined,
        sellCond: def.defaultSellCondition as Condition | undefined,
      });
    }
  }
  return units;
}

/** Per-index score (-1..+1) of a unit — its weighted contribution per candle. */
function unitScoreSeries(u: Unit, series: IndicatorSeries, closes: number[], n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (u.buyCond && evaluateCondition(u.buyCond, series, closes, i)) out[i] = 1;
    else if (u.sellCond && evaluateCondition(u.sellCond, series, closes, i)) out[i] = -1;
    else out[i] = defaultScore(u.name, series, closes, i);
  }
  return out;
}

export interface SmartResultRow {
  label: string;
  signals: number;
  buys: number;
  sells: number;
  trades?: number;
  profitPct?: number;
  winRate?: number;
}

export async function runSmartSelect(opts: {
  userId: string;
  symbol: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  feePct?: number;
  slippagePct?: number;
  exchange?: string;
}) {
  if (!TIMEFRAMES.includes(opts.timeframe as never)) throw new AppError("INVALID_TIMEFRAME", 400);
  const symbol = opts.symbol.toUpperCase();

  const candles = await getCandles({
    symbol, timeframe: opts.timeframe, start: opts.startDate, end: opts.endDate, exchange: opts.exchange,
  });
  if (candles.length < 100) throw new AppError("INSUFFICIENT_DATA", 422, { candles: candles.length });
  const n = candles.length;
  const closes = candles.map((c) => c.close);

  // ---- precompute every unit's score series once --------------------------
  const units = buildUnits();
  const unitScores = units.map((u) => {
    try {
      const series = computeIndicator(u.name, u.parameters, candles);
      return unitScoreSeries(u, series, closes, n);
    } catch {
      return null;
    }
  });
  const usable = units.map((u, i) => ({ u, scores: unitScores[i] })).filter((x) => x.scores !== null);

  // ---- Phase A: screen singles + pairs by signal count --------------------
  interface Cand { label: string; members: { u: Unit; w: number }[]; signals: number; buys: number; sells: number }
  const evalCombo = (members: { idx: number; w: number }[]): { signals: number; buys: number; sells: number } => {
    let buys = 0, sells = 0;
    const totalW = members.reduce((a, m) => a + m.w, 0);
    for (let i = WARMUP; i < n; i++) {
      let s = 0;
      for (const m of members) s += usable[m.idx].scores![i] * m.w;
      const score = s / totalW;
      if (score >= BUY_THRESHOLD) buys++;
      else if (score <= SELL_THRESHOLD) sells++;
    }
    return { signals: buys + sells, buys, sells };
  };

  const candidates: Cand[] = [];
  for (let i = 0; i < usable.length; i++) {
    const r = evalCombo([{ idx: i, w: 1 }]);
    if (r.signals > 0) candidates.push({ label: usable[i].u.label, members: [{ u: usable[i].u, w: 1 }], ...r });
  }
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const r = evalCombo([{ idx: i, w: 0.5 }, { idx: j, w: 0.5 }]);
      if (r.signals > 0) {
        candidates.push({
          label: `${usable[i].u.label} + ${usable[j].u.label}`,
          members: [{ u: usable[i].u, w: 0.5 }, { u: usable[j].u, w: 0.5 }],
          ...r,
        });
      }
    }
  }
  candidates.sort((a, b) => b.signals - a.signals);
  if (candidates.length === 0) throw new AppError("INSUFFICIENT_DATA", 422, { reason: "no candidate produced signals" });

  // ---- Phase B: real backtest for the top-signal candidates ---------------
  const feePct = opts.feePct ?? (await getSetting<number>("BACKTEST_FEE_PCT"));
  const slippagePct = opts.slippagePct ?? (await getSetting<number>("BACKTEST_SLIPPAGE_PCT"));
  const leaderboard: SmartResultRow[] = [];

  const toConfigs = (members: { u: Unit; w: number }[]): StrategyIndicatorConfig[] =>
    members.map((m) => ({
      name: m.u.name,
      parameters: m.u.parameters,
      weight: m.w,
      enabled: true,
      buyCondition: m.u.buyCond,
      sellCondition: m.u.sellCond,
    }));

  let best: { cand: Cand; profitPct: number; winRate: number; trades: number } | null = null;
  for (const cand of candidates.slice(0, TOP_BACKTEST_COUNT)) {
    const r = runBacktest({
      candles,
      indicators: toConfigs(cand.members),
      buyThreshold: BUY_THRESHOLD,
      sellThreshold: SELL_THRESHOLD,
      initialBalance: opts.initialBalance,
      riskPerTradePct: 1,
      stopLossPct: 1,
      takeProfitPct: 2,
      trailingStop: false,
      feePct,
      slippagePct,
    });
    leaderboard.push({
      label: cand.label, signals: cand.signals, buys: cand.buys, sells: cand.sells,
      trades: r.totalTrades, profitPct: r.profitPct, winRate: r.winRate,
    });
    // winner = most profitable; signal count breaks ties
    if (!best || r.profitPct > best.profitPct ||
      (r.profitPct === best.profitPct && cand.signals > best.cand.signals)) {
      best = { cand, profitPct: r.profitPct, winRate: r.winRate, trades: r.totalTrades };
    }
  }
  for (const c of candidates.slice(TOP_BACKTEST_COUNT)) {
    leaderboard.push({ label: c.label, signals: c.signals, buys: c.buys, sells: c.sells });
  }
  leaderboard.sort((a, b) =>
    (b.profitPct ?? -Infinity) - (a.profitPct ?? -Infinity) || b.signals - a.signals,
  );

  // ---- gate: refuse to create a losing strategy ----------------------------
  if (!best || best.profitPct <= 0) {
    logger.info("smart select — no profitable candidate", {
      module: "strategies", symbol, timeframe: opts.timeframe,
      candidates: candidates.length, bestProfit: best?.profitPct,
    });
    return {
      created: false,
      strategy: null,
      backtestId: null,
      winner: null,
      candidatesTested: candidates.length,
      leaderboard: leaderboard.slice(0, LEADERBOARD_SIZE),
    };
  }

  // ---- persist the winner as a real strategy + COMPLETED backtest ---------
  const input: StrategyInput = {
    name: `انتخاب هوشمند ${symbol} ${opts.timeframe}`,
    description: `ساخته‌شده خودکار — ترکیب: ${best.cand.label} · ${best.cand.signals} سیگنال · ${best.trades} معامله · سود ${best.profitPct.toFixed(2)}٪`,
    symbol,
    timeframe: opts.timeframe,
    buyThreshold: BUY_THRESHOLD,
    sellThreshold: SELL_THRESHOLD,
    riskPerTradePct: 1,
    stopLossPct: 1,
    takeProfitPct: 2,
    trailingStop: false,
    maxPositionPct: 100,
    orderType: "MARKET",
    indicators: toConfigs(best.cand.members),
  };
  const { strategy, version } = await createStrategy(opts.userId, input, "AI");

  const bt = await prisma.backtest.create({
    data: {
      userId: opts.userId,
      strategyId: strategy.id,
      versionId: version.id,
      symbol,
      timeframe: opts.timeframe,
      startDate: opts.startDate,
      endDate: opts.endDate,
      initialBalance: opts.initialBalance,
      feePct,
      slippagePct,
      status: "RUNNING",
      startedAt: new Date(),
    },
    include: { version: { include: { indicators: true } } },
  });
  const result = await runAndPersist(bt, toConfigs(best.cand.members).map((i) => ({
    ...i,
    buyCondition: JSON.stringify(i.buyCondition ?? {}),
    sellCondition: JSON.stringify(i.sellCondition ?? {}),
  })), candles);

  await notify({
    userId: opts.userId, type: "SYSTEM", severity: "SUCCESS",
    title: "انتخاب هوشمند تکمیل شد",
    body: `استراتژی «${strategy.name}» با ترکیب ${best.cand.label} ساخته شد (${result.totalTrades} معامله، ${result.profitPct.toFixed(2)}٪ سود).`,
    metadata: { strategyId: strategy.id },
  });
  await logActivity({ userId: opts.userId, action: "SMART_SELECT", entityType: "strategy", entityId: strategy.id });
  logger.info("smart select done", {
    module: "strategies", strategyId: strategy.id, winner: best.cand.label,
    profitPct: result.profitPct, candidates: candidates.length,
  });

  return {
    created: true,
    strategy: { id: strategy.id, name: strategy.name },
    backtestId: bt.id,
    winner: { label: best.cand.label, signals: best.cand.signals, profitPct: result.profitPct, trades: result.totalTrades },
    candidatesTested: candidates.length,
    leaderboard: leaderboard.slice(0, LEADERBOARD_SIZE),
  };
}
