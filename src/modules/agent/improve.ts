import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { parseJson } from "@/shared/utils";
import { getCandles } from "@/modules/pairs/service";
import { getSetting } from "@/modules/settings/service";
import { updateStrategy } from "@/modules/strategies/service";
import { runWalkForward } from "@/modules/backtest/walkforward";
import type { StrategyInput } from "@/modules/strategies/service";
import type { TradingAgent } from "@/generated/prisma/client";
import { agentLog } from "./service";
import { journalWrite } from "./journal";

/**
 * Self-improvement loop — evidence over hunches.
 *
 * Every cycle (worker calls runImprovementCycle every 30 min):
 *   1. PROBATION — a live carrying a candidate version at reduced sizeScale
 *      gets promoted (full size) after 24h/10 trades if its realized
 *      expectancy beats the baseline — or rolled back to the previous
 *      version if it doesn't.
 *   2. EVALUATE  — per-live metrics from real closed trades.
 *   3. ANALYZE   — losing trades' entry snapshots → dominant failure pattern.
 *   4. HYPOTHESIZE — ONE bounded tweak (never several at once).
 *   5. TEST      — walk-forward backtest (train 70% / test 30%).
 *   6. CANDIDATE — passes the gate → new version live at 25% size.
 *
 * Rate limits: max 1 hypothesis per strategy per 6h, and it needs ≥10 fresh
 * closed trades as evidence. Guardrails are constants — this loop cannot
 * touch them.
 */

const MIN_CLOSED_TRADES = 10;
const HYPOTHESIS_COOLDOWN_MS = 6 * 3_600_000;
const PROBATION_MIN_TRADES = 10;
const PROBATION_MIN_MS = 24 * 3_600_000;
const CANDIDATE_SIZE = 0.25;
const LOOKBACK_DAYS = 90;

interface ImproveStats {
  lastRunAt?: number;
  baselineExpectancy?: number;
  tried?: string[];
  hypothesis?: string;
  phase?: "SHADOW" | "PROMOTED" | "ROLLEDBACK";
  prevVersionId?: string;
  since?: number;
  closedAtStart?: number;
}

interface ManagedRow { symbol: string; strategyId?: string | null; liveStrategyId?: string | null }

// ---- bounded hypothesis set — each returns a small, explainable patch -----

interface Hypothesis {
  id: string;
  desc: string;   // Persian, written to journal + version hypothesis
  patch: (v: { buyThreshold: number; sellThreshold: number; stopLossPct: number; takeProfitPct: number; trailingStop: boolean; trailingStopPct: number | null; config: string }) => Partial<StrategyInput> | null;
}

const HYPOTHESES: Hypothesis[] = [
  {
    id: "RAISE_ENTRY_BAR",
    desc: "افزایش آستانه‌ی ورود برای حذف سیگنال‌های ضعیف",
    patch: (v) => v.buyThreshold < 0.8
      ? { buyThreshold: Math.round((v.buyThreshold + 0.1) * 100) / 100, sellThreshold: Math.round((v.sellThreshold - 0.1) * 100) / 100 }
      : null,
  },
  {
    id: "SCORE_GATE",
    desc: "گیت سخت‌گیرانه‌ی امتیاز ورود (حداقل امتیاز ترکیبی ۰٫۶۵)",
    patch: (v) => {
      const cfg = parseJson<Record<string, unknown>>(v.config, {});
      return cfg.minEntryScore === undefined ? { minEntryScore: 0.65 } : null;
    },
  },
  {
    id: "WIDER_TP",
    desc: "افزایش تیک‌پرافیت برای بهبود نسبت ریسک به ریوارد",
    patch: (v) => v.takeProfitPct < 15 ? { takeProfitPct: Math.round(v.takeProfitPct * 1.4 * 100) / 100 } : null,
  },
  {
    id: "TRAILING_STOP",
    desc: "فعال‌سازی تریلینگ‌استاپ برای قفل کردن سود",
    patch: (v) => !v.trailingStop ? { trailingStop: true, trailingStopPct: 1.5 } : null,
  },
  {
    id: "TIGHTER_SL",
    desc: "تنگ‌تر کردن حد ضرر برای کوچک‌تر کردن باخت‌ها",
    patch: (v) => v.stopLossPct > 0.4 ? { stopLossPct: Math.round(v.stopLossPct * 0.8 * 100) / 100 } : null,
  },
];

// ---------------------------------------------------------------------------

async function liveExpectancy(liveStrategyId: string, since?: Date) {
  const trades = await prisma.trade.findMany({
    where: { liveStrategyId, status: "CLOSED", ...(since ? { closedAt: { gte: since } } : {}) },
    select: { pnlPct: true, pnl: true, exitReason: true },
  });
  if (!trades.length) return { n: 0, expectancy: 0, winRate: 0, pnl: 0 };
  const wins = trades.filter((t) => (t.pnlPct ?? 0) > 0);
  return {
    n: trades.length,
    expectancy: trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length,
    winRate: (wins.length / trades.length) * 100,
    pnl: trades.reduce((s, t) => s + (t.pnl ?? 0), 0),
  };
}

/** dominant failure pattern from losing trades' entry snapshots */
async function failurePattern(liveStrategyId: string): Promise<string | null> {
  const losers = await prisma.signalLog.findMany({
    where: { liveStrategyId, decision: "ENTERED", outcomePnlPct: { lt: 0 } },
    orderBy: { createdAt: "desc" }, take: 30,
    select: { features: true, context: true },
  });
  if (losers.length < 4) return null;
  let ranging = 0, lowScore = 0, againstTrend = 0;
  for (const l of losers) {
    const f = parseJson<{ quality?: { regime?: string; components?: { trend?: number; regime?: number }; score?: number } }>(l.features, {});
    if (f.quality?.regime === "ranging") ranging++;
    if ((f.quality?.score ?? 1) < 0.55) lowScore++;
    if ((f.quality?.components?.trend ?? 1) < 0.4) againstTrend++;
  }
  const n = losers.length;
  if (ranging / n > 0.5) return "ranging";
  if (againstTrend / n > 0.5) return "against-trend";
  if (lowScore / n > 0.5) return "low-score";
  return null;
}

const PATTERN_TO_HYPOTHESIS: Record<string, string> = {
  "ranging": "SCORE_GATE",
  "against-trend": "RAISE_ENTRY_BAR",
  "low-score": "RAISE_ENTRY_BAR",
};

// ---------------------------------------------------------------------------
// probation — promote or roll back a candidate version
// ---------------------------------------------------------------------------

async function checkProbation(agent: TradingAgent, live: { id: string; symbol: string; versionId: string; candidateVersionId: string | null; sizeScale: number; stats: string }) {
  if (!live.candidateVersionId) return;
  const stats = parseJson<ImproveStats>(live.stats, {});
  const since = stats.since ? new Date(stats.since) : new Date(0);
  const cand = await liveExpectancy(live.id, since);
  const enoughTime = Date.now() - since.getTime() >= PROBATION_MIN_MS;
  const enoughTrades = cand.n >= PROBATION_MIN_TRADES;
  if (!enoughTime && !enoughTrades) return;

  const baseline = stats.baselineExpectancy ?? 0;
  if (cand.n >= 3 && cand.expectancy > baseline) {
    // PROMOTE — full size, clear the candidate marker
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { sizeScale: 1, candidateVersionId: null, stats: JSON.stringify({ ...stats, phase: "PROMOTED", hypothesis: undefined }) },
    });
    await journalWrite(agent.id, "LESSON",
      `نسخه‌ی جدید ${live.symbol} تأیید و ارتقا یافت — اکسپکتنسی ${cand.expectancy.toFixed(2)}٪ در ${cand.n} معامله (مبنا: ${baseline.toFixed(2)}٪)`,
      { reason: "probation passed", versionId: live.candidateVersionId });
    await agentLog(agent.id, "ACTION", `نسخه‌ی آزمایشی ${live.symbol} با موفقیت به نسخه‌ی اصلی ارتقا یافت.`);
  } else if (enoughTrades || enoughTime) {
    // ROLLBACK — revert to the version that was live before the hypothesis
    const prev = stats.prevVersionId;
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: {
        sizeScale: 1, candidateVersionId: null,
        ...(prev ? { versionId: prev } : {}),
        stats: JSON.stringify({ ...stats, phase: "ROLLEDBACK", hypothesis: undefined }),
      },
    });
    await journalWrite(agent.id, "LESSON",
      `فرضیه روی ${live.symbol} در محیط زنده رد شد — بازگشت به نسخه‌ی قبلی (اکسپکتنسی ${cand.expectancy.toFixed(2)}٪ در ${cand.n} معامله)`,
      { reason: "candidate underperformed baseline", versionId: live.candidateVersionId });
    await agentLog(agent.id, "ACTION", `نسخه‌ی آزمایشی ${live.symbol} ضعیف‌تر از مبنا بود — به نسخه‌ی قبلی برگشت.`);
  }
}

// ---------------------------------------------------------------------------
// hypothesis generation + walk-forward test
// ---------------------------------------------------------------------------

async function tryImprove(agent: TradingAgent, live: {
  id: string; userId: string; symbol: string; versionId: string; strategyId: string;
  stats: string; candidateVersionId: string | null;
}) {
  if (live.candidateVersionId) return; // a hypothesis is already on probation
  const stats = parseJson<ImproveStats>(live.stats, {});
  const lastRun = stats.lastRunAt ?? 0;
  if (Date.now() - lastRun < HYPOTHESIS_COOLDOWN_MS) return; // 1 change / 6h

  const sinceStart = stats.since ? new Date(stats.since) : undefined;
  const recent = await liveExpectancy(live.id, sinceStart);
  const freshTrades = recent.n - (stats.closedAtStart ?? 0);
  if (stats.closedAtStart === undefined || freshTrades < MIN_CLOSED_TRADES) {
    // not enough new evidence — just stamp the baseline counter
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { stats: JSON.stringify({ ...stats, closedAtStart: recent.n, baselineExpectancy: recent.expectancy }) },
    });
    return;
  }

  // pick a hypothesis — pattern-guided first, else the first untried
  const pattern = await failurePattern(live.id);
  const tried = new Set(stats.tried ?? []);
  const version = await prisma.strategyVersion.findUnique({
    where: { id: live.versionId }, include: { indicators: true },
  });
  if (!version) return;

  let hyp: Hypothesis | undefined;
  const preferred = pattern ? PATTERN_TO_HYPOTHESIS[pattern] : undefined;
  if (preferred && !tried.has(preferred)) hyp = HYPOTHESES.find((h) => h.id === preferred);
  if (!hyp) hyp = HYPOTHESES.find((h) => !tried.has(h.id));
  if (!hyp) return; // exhausted the bounded set

  const patch = hyp.patch(version);
  if (!patch) {
    // not applicable (e.g. trailing already on) — mark tried and move on
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { stats: JSON.stringify({ ...stats, tried: [...tried, hyp.id], lastRunAt: Date.now() }) },
    });
    return;
  }

  // build candidate version: full prior config + the single tweak
  const strategy = await prisma.strategy.findUnique({ where: { id: live.strategyId }, select: { name: true } });
  const merged = { ...JSON.parse(version.config), ...patch } as StrategyInput;
  merged.symbol = version.symbol;
  merged.name = merged.name ?? strategy?.name ?? `بهبود ${live.symbol}`;
  const candidate = await updateStrategy(live.userId, live.strategyId, merged);
  const candVersion = await prisma.strategyVersion.findUnique({
    where: { id: candidate.id }, include: { indicators: true },
  });
  if (!candVersion) return;

  // walk-forward validation on 90d of cached candles
  const candles = await getCandles({
    symbol: version.symbol, timeframe: version.timeframe,
    start: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000), end: new Date(),
    exchange: agent.exchange,
  });
  const feePct = await getSetting<number>("BACKTEST_FEE_PCT");
  const slippagePct = await getSetting<number>("BACKTEST_SLIPPAGE_PCT");
  const indicators = candVersion.indicators.map((i) => ({
    name: i.name, parameters: parseJson(i.parameters, {}), weight: i.weight,
    enabled: i.enabled, buyCondition: i.buyCondition, sellCondition: i.sellCondition,
  }));
  const wf = await runWalkForward(candVersion, indicators, candles, {
    initialBalance: 1000, feePct, slippagePct, symbol: version.symbol,
  });

  // persist as a Backtest row — the audit trail shows exactly what was tested
  await prisma.backtest.create({
    data: {
      userId: live.userId, strategyId: live.strategyId, versionId: candVersion.id,
      symbol: version.symbol, timeframe: version.timeframe,
      startDate: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000), endDate: new Date(),
      initialBalance: 1000, feePct, slippagePct,
      status: "COMPLETED", progress: 100, quotaConsumed: false,
      profitPct: wf.test.result.profitPct, winRate: wf.test.result.winRate,
      totalTrades: wf.test.result.totalTrades + wf.train.result.totalTrades,
      maxDrawdown: wf.test.result.maxDrawdown, profitFactor: wf.test.result.profitFactor,
      trainMetrics: JSON.stringify(wf.train.metrics), testMetrics: JSON.stringify(wf.test.metrics),
      passed: wf.acceptance.passed, hypothesis: hyp.desc,
      idempotencyKey: `improve-${agent.id}-${candVersion.id}`,
    },
  });
  await journalWrite(agent.id, "BACKTEST",
    `ولیدیشن walk-forward فرضیه «${hyp.desc}» روی ${live.symbol}: ${wf.acceptance.passed ? "پذیرفته شد ✓" : "رد شد ✗"}`,
    { reason: wf.acceptance.reasons.join("؛ ") || undefined,
      data: { train: wf.train.metrics, test: wf.test.metrics }, versionId: candVersion.id });

  const next: ImproveStats = {
    ...stats,
    lastRunAt: Date.now(),
    tried: [...tried, hyp.id],
    closedAtStart: recent.n,
    baselineExpectancy: recent.expectancy,
  };

  if (!wf.acceptance.passed) {
    await prisma.liveStrategy.update({ where: { id: live.id }, data: { stats: JSON.stringify(next) } });
    await journalWrite(agent.id, "LESSON",
      `فرضیه «${hyp.desc}» در بک‌تست رد شد: ${wf.acceptance.reasons[0] ?? "—"}`,
      { versionId: candVersion.id });
    return;
  }

  // CANDIDATE — the new version goes live at 25% size until probation ends
  await prisma.liveStrategy.update({
    where: { id: live.id },
    data: {
      versionId: candVersion.id, candidateVersionId: candVersion.id, sizeScale: CANDIDATE_SIZE,
      stats: JSON.stringify({
        ...next, hypothesis: hyp.desc, phase: "SHADOW",
        prevVersionId: version.id, since: Date.now(), closedAtStart: 0,
      }),
    },
  });
  await journalWrite(agent.id, "STRATEGY_CHANGE",
    `نسخه‌ی کاندید «${hyp.desc}» برای ${live.symbol} با سایز ۲۵٪ فعال شد`,
    { reason: pattern ? `الگوی باخت: ${pattern}` : "بهبود دوره‌ای",
      versionId: candVersion.id, strategyId: live.strategyId });
  await agentLog(agent.id, "ACTION",
    `فرضیه «${hyp.desc}» بک‌تست را گذراند — نسخه‌ی کاندید ${live.symbol} با سایز ۲۵٪ در حال آزمون زنده است.`);
}

// ---------------------------------------------------------------------------
// daily summary + goal review
// ---------------------------------------------------------------------------

async function dailySummary(agent: TradingAgent) {
  const last = await prisma.agentJournal.findFirst({
    where: { agentId: agent.id, type: "GOAL_UPDATE" }, orderBy: { createdAt: "desc" },
  });
  if (last && Date.now() - last.createdAt.getTime() < 20 * 3_600_000) return;

  const managed = parseJson<ManagedRow[]>(agent.managed, []);
  const liveIds = managed.map((m) => m.liveStrategyId).filter(Boolean) as string[];
  if (!liveIds.length) return;
  const day = await liveExpectancyMany(liveIds, new Date(Date.now() - 86_400_000));
  const lives = await prisma.liveStrategy.findMany({
    where: { id: { in: liveIds } }, select: { allocatedCapital: true },
  });
  const capital = lives.reduce((s, l) => s + l.allocatedCapital, 0);
  const pct = capital > 0 ? (day.pnl / capital) * 100 : 0;

  const summary =
    `گزارش روزانه — PnL: ${day.pnl.toFixed(2)} (${pct.toFixed(2)}٪)، ` +
    `${day.n} معامله (${day.n ? ((day.wins / day.n) * 100).toFixed(0) : 0}٪ برد)، اکسپکتنسی ${day.expectancy.toFixed(2)}٪. ` +
    `هدف تلاشی ۵٪ ${pct >= 5 ? "محقق شد" : `محقق نشد (${pct.toFixed(2)}٪)`}.`;
  await journalWrite(agent.id, "GOAL_UPDATE", summary, { data: { pnl: day.pnl, pct, trades: day.n, winRate: day.n ? (day.wins / day.n) * 100 : 0 } });
  await agentLog(agent.id, "INFO", summary);

  // 14-day honesty check — if the stretch target keeps missing, say so and
  // propose a review instead of inflating risk to chase it
  const ageMs = Date.now() - agent.createdAt.getTime();
  if (ageMs > 14 * 86_400_000) {
    const fortnight = await liveExpectancyMany(liveIds, new Date(Date.now() - 14 * 86_400_000));
    const capPct = capital > 0 ? (fortnight.pnl / capital) * 100 : 0;
    const meanDaily = capPct / 14;
    if (meanDaily < 5 && fortnight.n >= 10) {
      await journalWrite(agent.id, "GOAL_UPDATE",
        `پس از ۱۴ روز میانگین سود روزانه ${meanDaily.toFixed(2)}٪ است و به هدف تلاشی ۵٪ نرسیده — پیشنهاد بازنگری هدف یا استراتژی (بدون افزایش ریسک)`,
        { data: { meanDailyPct: meanDaily, trades: fortnight.n } });
    }
  }
}

async function liveExpectancyMany(liveIds: string[], since: Date) {
  const trades = await prisma.trade.findMany({
    where: { liveStrategyId: { in: liveIds }, status: "CLOSED", closedAt: { gte: since } },
    select: { pnlPct: true, pnl: true },
  });
  const wins = trades.filter((t) => (t.pnlPct ?? 0) > 0).length;
  return {
    n: trades.length, wins,
    pnl: trades.reduce((s, t) => s + (t.pnl ?? 0), 0),
    expectancy: trades.length ? trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length : 0,
  };
}

// ---------------------------------------------------------------------------

/** one improvement pass over every running agent — worker calls this */
export async function runImprovementCycle(): Promise<void> {
  const agents = await prisma.tradingAgent.findMany({ where: { status: "RUNNING" } });
  for (const agent of agents) {
    try {
      const managed = parseJson<ManagedRow[]>(agent.managed, []);
      const liveIds = managed.map((m) => m.liveStrategyId).filter(Boolean) as string[];
      if (!liveIds.length) continue;
      const lives = await prisma.liveStrategy.findMany({
        where: { id: { in: liveIds }, status: { in: ["RUNNING", "STARTING", "PAUSED", "DEGRADED"] } },
      });
      for (const live of lives) {
        await checkProbation(agent, live).catch((e) =>
          logger.warn("probation check failed", { module: "improve", liveId: live.id, error: String(e).slice(0, 120) }));
        await tryImprove(agent, { ...live, strategyId: live.strategyId }).catch((e) =>
          logger.warn("improve failed", { module: "improve", liveId: live.id, error: String(e).slice(0, 120) }));
      }
      await dailySummary(agent).catch(() => {});
    } catch (e) {
      logger.warn("improvement cycle error", { module: "improve", agentId: agent.id, error: String(e).slice(0, 120) });
    }
  }
}
