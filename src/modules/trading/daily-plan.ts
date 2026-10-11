import { prisma } from "@/infrastructure/database/prisma";
import { parseJson } from "@/shared/utils";
import type { DailyPlan } from "@/generated/prisma/client";

/**
 * Daily goal state machine — success is judged on the day's net PnL, never
 * on a single trade. Three targets:
 *   min 0.5% · normal 1%–1.5% · stretch 5% (never a reason to raise risk)
 *
 * States:
 *   BUILDING   — below normal target; normal size, normal thresholds
 *   PROTECTING — ≥ normal target; half size, higher probability threshold,
 *                trailing on the day's peak (give back >40% → LOCKED)
 *   LOCKED     — stretch reached or daily trailing fired; NO new entries
 *   DEFENSIVE  — day loss below −1%; half size, highest probability only
 *   (the −3% circuit breaker lives in guardrails — above this layer)
 *
 * Hard rule: this layer can only TIGHTEN behavior. `entryGate` returns a
 * multiplier and thresholds that sit ON TOP of the fixed guardrails.
 */

export type DailyState = "BUILDING" | "PROTECTING" | "LOCKED" | "DEFENSIVE";

const TRAIL_GIVEBACK = 0.4;      // give back >40% of day's peak → lock
const DEFENSIVE_AT = -1;         // % day pnl
const LOCK_STRETCH = 5;          // % — stretch target locks the day
const PROTECT_AT = 1;            // % — normal target

const utcDay = (d = new Date()) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

/** today's plan for an agent — created on first touch each UTC day */
export async function ensureDailyPlan(agent: {
  id: string; userId: string; exchange: string; managed: string;
}): Promise<DailyPlan> {
  const day = utcDay();
  const existing = await prisma.dailyPlan.findUnique({
    where: { agentId_date: { agentId: agent.id, date: day } },
  });
  if (existing) return existing;

  const forecastNote = await dailyForecast(agent.exchange,
    parseJson<{ symbol: string }[]>(agent.managed, []).map((m) => m.symbol));

  const plan = await prisma.dailyPlan.create({
    data: {
      agentId: agent.id, userId: agent.userId, date: day,
      forecastNote: JSON.stringify(forecastNote),
    },
  });
  const { journalWrite } = await import("@/modules/agent/journal");
  await journalWrite(agent.id, "DAILY_PLAN",
    `برنامه‌ی امروز ساخته شد — ${forecastNote.summary}`,
    { data: forecastNote });
  return plan;
}

/** realized PnL % of the plan's managed lives since UTC midnight today */
async function dayPnlPct(agentId: string): Promise<{ pct: number; liveIds: string[] }> {
  const agent = await prisma.tradingAgent.findUnique({ where: { id: agentId }, select: { managed: true } });
  const liveIds = parseJson<{ liveStrategyId?: string }[]>(agent?.managed ?? "[]", [])
    .map((m) => m.liveStrategyId).filter(Boolean) as string[];
  if (!liveIds.length) return { pct: 0, liveIds };
  const [closed, lives] = await Promise.all([
    prisma.trade.findMany({
      where: { liveStrategyId: { in: liveIds }, status: "CLOSED", closedAt: { gte: utcDay() } },
      select: { pnl: true },
    }),
    prisma.liveStrategy.findMany({ where: { id: { in: liveIds } }, select: { allocatedCapital: true } }),
  ]);
  const realized = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const capital = lives.reduce((s, l) => s + l.allocatedCapital, 0);
  return { pct: capital > 0 ? (realized / capital) * 100 : 0, liveIds };
}

/** trades opened today across the managed set — feeds the 8/day churn cap */
async function tradesToday(liveIds: string[]): Promise<number> {
  if (!liveIds.length) return 0;
  return prisma.trade.count({
    where: { liveStrategyId: { in: liveIds }, openedAt: { gte: utcDay() } },
  });
}

/** pure state-transition decision — LOCKED is sticky, everything else recomputes */
export function decideState(
  current: DailyState,
  pct: number,
  peak: number,
  currentReason?: string | null,
): { state: DailyState; lockedReason: string | null } {
  if (current === "LOCKED") return { state: "LOCKED", lockedReason: currentReason ?? null };
  if (pct <= DEFENSIVE_AT) return { state: "DEFENSIVE", lockedReason: null };
  if (pct >= LOCK_STRETCH)
    return { state: "LOCKED", lockedReason: `به هدف تلاشی ${LOCK_STRETCH}٪ رسید — روز قفل شد` };
  if (pct >= PROTECT_AT) {
    // daily trailing — gave back >40% of the day's peak profit → lock
    if (peak > 0 && (peak - pct) / peak > TRAIL_GIVEBACK)
      return {
        state: "LOCKED",
        lockedReason: `بیش از ${TRAIL_GIVEBACK * 100}٪ از اوج سود روز (${peak.toFixed(2)}٪) پس داده شد`,
      };
    return { state: "PROTECTING", lockedReason: null };
  }
  return { state: "BUILDING", lockedReason: null };
}

/** recompute state from fresh numbers; returns the updated plan (writes transitions) */
export async function refreshDailyPlan(agent: {
  id: string; userId: string; exchange: string; managed: string;
}): Promise<DailyPlan> {
  const plan = await ensureDailyPlan(agent);
  const { pct, liveIds } = await dayPnlPct(agent.id);
  const nTrades = await tradesToday(liveIds);
  const peak = Math.max(plan.peakPnlPct, pct);

  const { state, lockedReason } = decideState(
    plan.state as DailyState, pct, peak, plan.lockedReason);

  if (state !== plan.state || Math.abs(pct - plan.realizedPnlPct) > 0.005 || nTrades !== plan.tradesToday || peak !== plan.peakPnlPct) {
    const updated = await prisma.dailyPlan.update({
      where: { id: plan.id },
      data: {
        state, lockedReason,
        realizedPnlPct: pct, peakPnlPct: peak, tradesToday: nTrades,
        sizeScale: state === "PROTECTING" || state === "DEFENSIVE" ? 0.5 : 1,
      },
    });
    if (state !== plan.state) {
      const { journalWrite } = await import("@/modules/agent/journal");
      const fa: Record<DailyState, string> = {
        BUILDING: "در حال ساخت", PROTECTING: "محافظت از سود",
        LOCKED: "قفل — معامله‌ی جدید ممنوع", DEFENSIVE: "دفاعی",
      };
      await journalWrite(agent.id, "DAILY_STATE_CHANGE",
        `وضعیت روز از ${fa[plan.state as DailyState]} به ${fa[state]} تغییر کرد — PnL روز ${pct.toFixed(2)}٪`,
        { reason: lockedReason ?? undefined, data: { from: plan.state, to: state, pct } });
    }
    return updated;
  }
  return plan;
}

export interface DailyEntryGate {
  allow: boolean;
  sizeScale: number;            // multiply into position sizing (≤1 always)
  minScoreBoost: number;        // added onto the signal-score floor
  minForecastP: number;         // calibrated-probability floor when a model exists
  reason?: string;
}

/** the gate every entry consults — ONLY ever tightens, never loosens */
export function dailyEntryGate(plan: DailyPlan): DailyEntryGate {
  switch (plan.state as DailyState) {
    case "LOCKED":
      return { allow: false, sizeScale: 0, minScoreBoost: 0, minForecastP: 1, reason: plan.lockedReason ?? "روز قفل شده — معامله‌ی جدید ممنوع" };
    case "PROTECTING":
      return { allow: true, sizeScale: 0.5, minScoreBoost: 0.1, minForecastP: 0.62, reason: "حالت محافظت — سایز نصف، فقط سیگنال‌های قوی" };
    case "DEFENSIVE":
      return { allow: true, sizeScale: 0.5, minScoreBoost: 0.15, minForecastP: 0.66, reason: "حالت دفاعی — زیان روز از ۱٪ گذشته" };
    default:
      return { allow: true, sizeScale: 1, minScoreBoost: 0, minForecastP: 0.58 };
  }
}

/** fee-churn cap — checked separately so LOCKED still wins when both fire */
export async function tradesTodayForAgent(agentId: string): Promise<number> {
  const agent = await prisma.tradingAgent.findUnique({ where: { id: agentId }, select: { managed: true } });
  const liveIds = parseJson<{ liveStrategyId?: string }[]>(agent?.managed ?? "[]", [])
    .map((m) => m.liveStrategyId).filter(Boolean) as string[];
  return tradesToday(liveIds);
}

// ---------------------------------------------------------------------------
// "forecast of the day" — a light statistical read, honest about its nature
// ---------------------------------------------------------------------------

interface DailyForecastNote {
  expectedVolatility: "low" | "normal" | "high";
  dominantDirection: "up" | "down" | "mixed";
  opportunityLevel: "many" | "some" | "few";
  summary: string;   // Persian one-liner
}

async function dailyForecast(exchange: string, symbols: string[]): Promise<DailyForecastNote> {
  const { marketStats } = await import("@/modules/strategies/suggest");
  const { getCandles } = await import("@/modules/pairs/service");
  let trending = 0, up = 0, n = 0, vols: number[] = [];
  for (const s of symbols.slice(0, 6)) {
    const candles = await getCandles({
      symbol: s, timeframe: "1h", exchange,
      start: new Date(Date.now() - 48 * 3_600_000), end: new Date(),
    }).catch(() => []);
    if (candles.length < 30) continue;
    const st = marketStats(candles);
    n++;
    if (st.regime === "trending") trending++;
    if (st.trendPct > 0.3) up++;
    else if (st.trendPct < -0.3) up--;
    vols.push(st.volPct);
  }
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const expectedVolatility = avgVol > 2.5 ? "high" : avgVol < 0.8 ? "low" : "normal";
  const dominantDirection = up > 0 ? "up" : up < 0 ? "down" : "mixed";
  const opportunityLevel = !n ? "few" : expectedVolatility === "high" || trending / n > 0.6 ? "many" : "some";
  const dirFa = { up: "صعودی", down: "نزولی", mixed: "مختلط" }[dominantDirection];
  const volFa = { low: "کم", normal: "متوسط", high: "زیاد" }[expectedVolatility];
  const oppFa = { many: "زیاد", some: "متوسط", few: "کم" }[opportunityLevel];
  return {
    expectedVolatility, dominantDirection, opportunityLevel,
    summary: `نوسان مورد انتظار ${volFa}، جهت غالب ${dirFa}، فرصت معاملاتی ${oppFa}`,
  };
}

/** end-of-day summary (Persian) — journal + notification body */
export async function closeDailyPlan(agentId: string): Promise<string | null> {
  const yesterday = utcDay(new Date(Date.now() - 86_400_000));
  const plan = await prisma.dailyPlan.findUnique({
    where: { agentId_date: { agentId, date: yesterday } },
  });
  if (!plan) return null;
  const { pct } = await dayPnlPct(agentId);
  const preds = await prisma.prediction.findMany({
    where: { resolvedAt: { gte: yesterday, lt: utcDay() }, outcome: { in: ["WIN", "LOSS"] } },
    select: { outcome: true },
  });
  const acc = preds.length ? (preds.filter((p) => p.outcome === "WIN").length / preds.length) * 100 : null;
  const summary =
    `جمع‌بندی دیروز: PnL خالص ${pct.toFixed(2)}٪ · هدف ${plan.targetNormal}٪ (${plan.targetStretch}٪ تلاشی) · ` +
    `${plan.tradesToday} معامله · حالت پایانی ${plan.state}` +
    (acc !== null ? ` · دقت پیش‌بینی‌های دیروز ${acc.toFixed(0)}٪` : "");
  const { journalWrite } = await import("@/modules/agent/journal");
  await journalWrite(agentId, "GOAL_UPDATE", summary, {
    data: { date: yesterday, pnlPct: pct, state: plan.state, trades: plan.tradesToday, forecastAccuracy: acc },
  });
  return summary;
}
