import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { journalWrite, journalRecent } from "@/modules/agent/journal";
import { getSetting } from "@/modules/settings/service";
import { tfMs } from "@/modules/pairs/service";
import { faNumber, faPercent, parseJson } from "@/shared/utils";
import { getCandles, dataFresh, dataFreshCheckedAt } from "./data";
import { replaySetupRule, POSITION_FRACTION, type SetupRule } from "./backtest";
import { lastScanAt } from "./setups";
import { configTimeframes } from "./config";
import { systemAgentId } from "./jobs";
import { STATE_FA } from "./lifecycle";
import type { Candle } from "@/modules/exchanges/types";
import type { Setup } from "@/generated/prisma/client";

/**
 * Stats, memory & degradation —
 * - outcome-tracker (hourly): counterfactual evaluation of terminal setups
 *   that never traded — "what would the outcome have been?" written back to
 *   outcome/outcomePnlPct with meta.hypothetical so stats can count traded
 *   and untracked signals honestly.
 * - stats-aggregator (daily): per-typeKey live accuracy + expectancy from
 *   Setup outcomes + PaperTrades; when enough paper evidence exists and it is
 *   significantly worse than the backtest expectancy the pattern is degraded
 *   (degraded + degradedReason + weight cut → lower ranking).
 * - daily-report (end of UTC day): Persian summary + lesson into the journal.
 * - signalFactorySection: the AGENT_STATE.md memory block.
 */

export const DEGRADE_MIN_PAPER_TRADES = 20;
export const DEGRADE_MIN_PAPER_DAYS = 7;
export const DEGRADE_EXPECTANCY_RATIO = 0.5;
export const DEGRADED_WEIGHT = 0.5;
export const MIN_WEIGHT = 0.1;
const DAY_MS = 86_400_000;

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(xs.length, 1);

// ---------------------------------------------------------------------------
// outcome-tracker — hypothetical evaluation of setups that never traded
// ---------------------------------------------------------------------------

export interface HypoEval {
  outcome: "TP1_HIT" | "TP2_HIT" | "SL_HIT" | "EXPIRED";
  pnlPct: number;
  triggered: boolean;
}

/**
 * Counterfactual: replay the setup's rule over candles from its validity
 * window [createdAt, expiresAt] (+ one candle for the entry fill). The first
 * simulated occurrence is the answer; no confirm inside the window is an
 * honest EXPIRED at 0%.
 */
export function hypotheticalOutcome(
  setup: Pick<Setup, "direction" | "confirmRule" | "triggerPrice" | "entryLow" | "entryHigh" | "tp1" | "tp2" | "sl" | "timeframe" | "createdAt" | "expiresAt">,
  candles: Candle[],
  opts: { feePct: number; slippagePct: number },
): HypoEval | null {
  const cAt = setup.createdAt.getTime();
  const expAt = setup.expiresAt.getTime();
  const inWindow = candles.filter((c) => c.time >= cAt);
  if (!inWindow.length) return null;
  // candles opening at/after expiresAt can't confirm (their close is past the
  // deadline) — exactly one is kept as the entry fill for a last-bar confirm
  const firstPast = inWindow.findIndex((c) => c.time >= expAt);
  const series = firstPast < 0 ? inWindow : inWindow.slice(0, firstPast + 1);

  const rule: SetupRule = {
    direction: setup.direction === "SHORT" ? "SHORT" : "LONG",
    confirmRule: setup.confirmRule,
    triggerPrice: setup.triggerPrice,
    entryLow: setup.entryLow,
    entryHigh: setup.entryHigh,
    tp1: setup.tp1,
    tp2: setup.tp2,
    sl: setup.sl,
    horizonCandles: Math.max(1, Math.round((expAt - cAt) / tfMs(setup.timeframe))),
  };
  const { trades } = replaySetupRule(rule, series, {
    feePct: opts.feePct,
    slippagePct: opts.slippagePct,
    initialBalance: 10_000,
  });
  const first = trades[0];
  if (!first) return { outcome: "EXPIRED", pnlPct: 0, triggered: false };
  const legs = trades.filter((t) => t.entryTime === first.entryTime);
  const last = legs[legs.length - 1];
  const outcome: HypoEval["outcome"] =
    last.exitReason === "TP2_HIT" ? "TP2_HIT"
    : legs.some((t) => t.exitReason === "PARTIAL_TP") ? "TP1_HIT"
    : last.exitReason === "SL_HIT" ? "SL_HIT" : "EXPIRED";
  const pnlPct = Math.round((legs.reduce((s, t) => s + t.pnl, 0) / (10_000 * POSITION_FRACTION)) * 100 * 1e4) / 1e4;
  return { outcome, pnlPct, triggered: true };
}

export interface OutcomeTrackerDeps {
  fetchCandles?: (exchange: string, symbol: string, timeframe: string, limit: number) => Promise<Candle[]>;
  feePct?: number;
  slippagePct?: number;
  now?: number;
  limit?: number;
}

/** outcome-tracker body (1h). Terminal setups that never opened a paper
 *  trade get their counterfactual outcome recorded once the validity window
 *  has fully elapsed. */
export async function runOutcomeTracker(deps: OutcomeTrackerDeps = {}): Promise<{
  checked: number; evaluated: number; triggered: number; skipped: number; failed: number;
}> {
  const now = deps.now ?? Date.now();
  const feePct = deps.feePct ?? (await getSetting<number>("BACKTEST_FEE_PCT"));
  const slippagePct = deps.slippagePct ?? (await getSetting<number>("BACKTEST_SLIPPAGE_PCT"));
  const fetchCandles = deps.fetchCandles ?? ((e, s, tf, n) => getCandles(e, s, tf, n));

  const pending = await prisma.setup.findMany({
    where: {
      state: { in: ["EXPIRED", "INVALIDATED", "REJECTED"] },
      outcome: null,
      expiresAt: { lte: new Date(now) },
      paperTrade: null,
    },
    orderBy: { expiresAt: "asc" },
    take: deps.limit ?? 100,
  });

  const out = { checked: 0, evaluated: 0, triggered: 0, skipped: 0, failed: 0 };
  for (const setup of pending) {
    out.checked++;
    try {
      const need = Math.min(
        500, Math.ceil((now - setup.createdAt.getTime()) / tfMs(setup.timeframe)) + 8,
      );
      const candles = await fetchCandles(setup.exchange, setup.symbol, setup.timeframe, need);
      const r = hypotheticalOutcome(setup, candles, { feePct, slippagePct });
      if (!r) { out.skipped++; continue; } // window outside fetched data — retry next hour
      const meta = { ...parseJson<Record<string, unknown>>(setup.meta, {}), hypothetical: true, triggered: r.triggered };
      await prisma.setup.update({
        where: { id: setup.id },
        data: { outcome: r.outcome, outcomePnlPct: r.pnlPct, meta: JSON.stringify(meta) },
      });
      out.evaluated++;
      if (r.triggered) out.triggered++;
    } catch (e) {
      out.failed++;
      logger.warn("outcome-tracker step failed", {
        module: "signal-factory", setupId: setup.id, symbol: setup.symbol,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// stats-aggregator — per-typeKey live stats + paper-vs-backtest degradation
// ---------------------------------------------------------------------------

export interface TypeLiveStats {
  key: string;
  paperTrades: number;
  paperExpectancy: number | null;
  paperDays: number;
  evaluated: number;            // real closes + hypothetical evals
  taken: number;                // signals that actually produced a trade
  liveAccuracy: number | null;  // % of taken signals with pnl > 0
  liveExpectancy: number | null; // mean outcomePnlPct over every evaluated signal
}

/** Recompute a pattern's live stats from Setup outcomes + PaperTrades and
 *  persist the paper counters on SetupType. */
export async function aggregateSetupType(typeKey: string, now = Date.now()): Promise<TypeLiveStats | null> {
  const type = await prisma.setupType.findUnique({ where: { key: typeKey } });
  if (!type) return null;
  const setups = await prisma.setup.findMany({
    where: { typeKey, outcomePnlPct: { not: null } },
    select: { outcomePnlPct: true, meta: true, paperTrade: { select: { openedAt: true } } },
  });
  const paper = setups.filter((s) => s.paperTrade !== null);
  const hypoTaken = setups.filter(
    (s) => s.paperTrade === null && parseJson<{ triggered?: boolean }>(s.meta, {}).triggered === true,
  );
  const allPnls = setups.map((s) => s.outcomePnlPct!);
  const takenPnls = [...paper, ...hypoTaken].map((s) => s.outcomePnlPct!);
  const firstPaper = paper.reduce((m, s) => Math.min(m, s.paperTrade!.openedAt.getTime()), Infinity);

  const stats: TypeLiveStats = {
    key: typeKey,
    paperTrades: paper.length,
    paperExpectancy: paper.length ? mean(paper.map((s) => s.outcomePnlPct!)) : null,
    paperDays: paper.length ? Math.floor((now - firstPaper) / DAY_MS) : 0,
    evaluated: allPnls.length,
    taken: takenPnls.length,
    liveAccuracy: takenPnls.length ? (takenPnls.filter((p) => p > 0).length / takenPnls.length) * 100 : null,
    liveExpectancy: allPnls.length ? mean(allPnls) : null,
  };
  await prisma.setupType.update({
    where: { key: typeKey },
    data: {
      paperTrades: stats.paperTrades,
      paperExpectancy: stats.paperExpectancy,
      paperDays: stats.paperDays,
    },
  });
  return stats;
}

/** Degradation gate — enough live evidence AND paper expectancy below half
 *  of the backtest expectancy. */
export function shouldDegrade(t: {
  paperTrades: number;
  paperDays: number;
  paperExpectancy: number | null;
  expectancy: number;
}): boolean {
  if (t.paperExpectancy === null) return false;
  const enough = t.paperTrades >= DEGRADE_MIN_PAPER_TRADES || t.paperDays >= DEGRADE_MIN_PAPER_DAYS;
  return enough && t.paperExpectancy < t.expectancy * DEGRADE_EXPECTANCY_RATIO;
}

/** stats-aggregator body (daily). */
export async function runStatsAggregator(now = Date.now()): Promise<{
  types: number; degraded: string[];
}> {
  const types = await prisma.setupType.findMany();
  const degraded: string[] = [];
  for (const type of types) {
    try {
      const stats = await aggregateSetupType(type.key, now);
      if (!stats) continue;
      if (type.degraded || !shouldDegrade({
        paperTrades: stats.paperTrades,
        paperDays: stats.paperDays,
        paperExpectancy: stats.paperExpectancy,
        expectancy: type.expectancy,
      })) continue;

      const weight = Math.max(MIN_WEIGHT, Math.round(type.weight * DEGRADED_WEIGHT * 100) / 100);
      const reason = `عملکرد پیپر ${faPercent(stats.paperExpectancy!)} در برابر انتظار بک‌تست ${faPercent(type.expectancy)} — پس از ${stats.paperTrades} معامله پیپر در ${stats.paperDays} روز`;
      await prisma.setupType.update({
        where: { key: type.key },
        data: { degraded: true, degradedReason: reason, weight },
      });
      const owner = await prisma.setup.findFirst({
        where: { typeKey: type.key }, select: { userId: true },
      });
      if (owner) {
        await journalWrite(
          await systemAgentId(owner.userId), "DEGRADED",
          `الگوی ${type.kind} (${type.key}) تضعیف شد — وزن رتبه‌بندی به ${weight} کاهش یافت`,
          { reason, data: { typeKey: type.key, ...stats, backtestExpectancy: type.expectancy } },
        );
      }
      degraded.push(type.key);
    } catch (e) {
      logger.warn("stats aggregation failed for type", {
        module: "signal-factory", typeKey: type.key,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return { types: types.length, degraded };
}

// ---------------------------------------------------------------------------
// daily-report — end-of-UTC-day Persian summary + lesson of the day
// ---------------------------------------------------------------------------

function lessonOfDay(x: {
  produced: number;
  degradedToday: number;
  closed: { symbol: string; pnlPct: number | null }[];
}): string {
  if (x.degradedToday > 0) return "الگویی تضعیف شد — عملکرد زنده حرف آخر را می‌زند، نه بک‌تست";
  if (x.produced === 0) return "امروز ستاپ مناسبی نبود — عدم معامله هم تصمیم است";
  const sorted = [...x.closed].sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));
  const worst = sorted[0], best = sorted.at(-1);
  if (worst && (worst.pnlPct ?? 0) <= -2) {
    return `بدترین نتیجه: ${worst.symbol} با ${faPercent(worst.pnlPct)} — استاپ به‌موقع زیان را محدود کرد`;
  }
  if (best && (best.pnlPct ?? 0) >= 2) {
    return `بهترین نتیجه: ${best.symbol} با ${faPercent(best.pnlPct)} — صبر تا تریگر جواب داد`;
  }
  if (x.closed.length) return "نتایج پیپر امروز متعادل بود — پایش ادامه دارد";
  return "ستاپ‌ها هنوز به تریگر نرسیدند — صبر تا تأیید";
}

/** daily-report body — one journal entry per configured user. */
export async function runDailyReport(now = Date.now()): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const configs = await prisma.signalMakerConfig.findMany();
  let wrote = 0;
  for (const cfg of configs) {
    try {
      const agentId = await systemAgentId(cfg.userId);
      const [produced, armed, opened, closed, degradedToday] = await Promise.all([
        prisma.setup.count({ where: { userId: cfg.userId, createdAt: { gte: dayStart } } }),
        prisma.setup.count({ where: { userId: cfg.userId, activatedAt: { gte: dayStart } } }),
        prisma.paperTrade.count({ where: { userId: cfg.userId, openedAt: { gte: dayStart } } }),
        prisma.paperTrade.findMany({
          where: { userId: cfg.userId, status: "CLOSED", closedAt: { gte: dayStart } },
          select: { symbol: true, pnl: true, pnlPct: true },
        }),
        prisma.agentJournal.count({ where: { agentId, type: "DEGRADED", createdAt: { gte: dayStart } } }),
      ]);
      const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
      const pnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const avgPct = closed.length ? closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length : 0;
      const lesson = lessonOfDay({ produced, degradedToday, closed });
      await journalWrite(agentId, "DAILY_REPORT",
        [
          `گزارش روزانه‌ی سیگنال‌ساز ${cfg.exchange}/${cfg.marketType}`,
          `ستاپ‌ها: ${produced} تولید · ${armed} مسلح · ${opened} پیپر باز`,
          closed.length
            ? `پیپر بسته: ${closed.length} (${wins} برد) — نتیجه ${faNumber(Math.round(pnl * 100) / 100, true)} واحد · میانگین ${faPercent(avgPct)}`
            : "پیپر بسته: هیچ",
          `معامله‌ی زنده: ${cfg.liveTradingEnabled ? "فعال" : "خاموش"}`,
          `درس روز: ${lesson}`,
        ].join("\n"),
        { data: { produced, armed, opened, closed: closed.length, wins, pnl, avgPct, degradedToday, lesson } },
      );
      wrote++;
    } catch (e) {
      logger.warn("daily report failed", {
        module: "signal-factory", userId: cfg.userId,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// AGENT_STATE.md section — signal-factory memory block
// ---------------------------------------------------------------------------

const ACTIVE_STATES = ["PROPOSED", "BACKTESTED", "WAITING_TRIGGER", "PAPER_OPEN"];

function ageFa(ts: number | null): string {
  if (!ts) return "هرگز";
  const m = Math.floor((Date.now() - ts) / 60_000);
  return m < 60 ? `${m} دقیقه پیش` : m < 1440 ? `${Math.floor(m / 60)} ساعت پیش` : `${Math.floor(m / 1440)} روز پیش`;
}

/** The signal-factory block appended to AGENT_STATE.md — config, scan
 *  staleness, active setups, per-type stats, job health, promotions, TODOs. */
export async function signalFactorySection(userId: string): Promise<string> {
  const cfg = await prisma.signalMakerConfig.findUnique({ where: { userId } });
  if (!cfg) return "";
  const [setups, stateCounts, types, jobs, lastScan] = await Promise.all([
    prisma.setup.findMany({
      where: { userId, state: { in: ACTIVE_STATES } },
      orderBy: { score: "desc" }, take: 8,
      select: { symbol: true, kind: true, direction: true, state: true, score: true, backtestLabel: true },
    }),
    prisma.setup.groupBy({ by: ["state"], where: { userId }, _count: { _all: true } }),
    prisma.setupType.findMany({ orderBy: { samples: "desc" }, take: 8 }),
    prisma.jobRegistry.findMany({ orderBy: { name: "asc" } }),
    lastScanAt(userId),
  ]);
  const sys = await prisma.tradingAgent.findUnique({
    where: { userId_symbol_mode: { userId, symbol: "SIGNAL_FACTORY", mode: "PAPER" } },
    select: { id: true },
  });
  const promos = sys ? await journalRecent(sys.id, 5, "PROMOTION_REQUEST") : [];

  const scanStale = !lastScan || Date.now() - lastScan > cfg.scanEveryHours * 3_600_000;
  const stateLine = stateCounts.map((s) => `${STATE_FA[s.state] ?? s.state}:${s._count._all}`).join(" · ");

  const todos: string[] = [];
  const pendingBt = stateCounts.find((s) => s.state === "PROPOSED")?._count._all ?? 0;
  if (pendingBt) todos.push(`${pendingBt} ستاپ در انتظار بک‌تست/تریگر`);
  const deg = types.filter((t) => t.degraded).length;
  if (deg) todos.push(`${deg} الگوی تضعیف‌شده — وزن کاهش‌یافته، قبل از ارتقا به زنده شواهد جدید لازم`);
  const deadJobs = jobs.filter((j) => !j.enabled);
  if (deadJobs.length) todos.push(`jobهای غیرفعال: ${deadJobs.map((j) => j.name).join("، ")} — بررسی JobRegistry`);

  return `
## سیگنال‌ساز
- صرافی فعال: ${cfg.exchange}/${cfg.marketType} · quote ${cfg.quote} · تایم‌فریم‌ها ${configTimeframes(cfg).join(",")} · اسکن هر ${cfg.scanEveryHours}h · سیستم ${cfg.enabled ? "فعال" : "خاموش"} · معامله‌ی زنده ${cfg.liveTradingEnabled ? "فعال" : "خاموش"}
- آخرین اسکن: ${ageFa(lastScan || null)}${scanStale ? " (کهنه — اسکن معوق)" : ""} · داده: ${dataFresh(cfg.exchange) ? "تازه" : "کهنه"}${dataFreshCheckedAt(cfg.exchange) ? ` (${ageFa(dataFreshCheckedAt(cfg.exchange))})` : ""}
- ستاپ‌های فعال: ${setups.length}${stateLine ? ` — ${stateLine}` : ""}
${setups.map((s) => `  - ${s.symbol} ${s.direction} ${s.kind} · ${STATE_FA[s.state] ?? s.state} · امتیاز ${s.score} · بک‌تست ${s.backtestLabel}`).join("\n") || "  - هیچ"}
- الگوها:
${types.map((t) => `  - ${t.kind}:${t.paramsHash.slice(0, 6)} · بک‌تست exp ${t.expectancy.toFixed(2)}٪ (${t.samples} نمونه) · پیپر ${t.paperTrades} معامله/${t.paperDays}روز${t.paperExpectancy != null ? ` exp ${t.paperExpectancy.toFixed(2)}٪` : ""}${t.degraded ? ` · تضعیف‌شده (وزن ${t.weight})` : ""}${t.liveApproved ? " · تأیید زنده" : ""}`).join("\n") || "  - هیچ"}
- jobها:
${jobs.map((j) => `  - ${j.name} · ${!j.enabled ? "غیرفعال" : j.lastStatus ?? "ثبت‌شده"} · آخرین اجرا ${ageFa(j.lastRunAt?.getTime() ?? null)}${j.failCount ? ` · خطای پیاپی ×${j.failCount}` : ""}`).join("\n") || "  - هیچ"}
- درخواست‌های ارتقا به زنده: ${promos.length ? promos.map((p) => p.summary).join(" | ") : "هیچ"}
- TODO: ${todos.join(" | ") || "هیچ"}
`;
}
