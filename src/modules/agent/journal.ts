import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { parseJson } from "@/shared/utils";
import type { TradingAgent } from "@/generated/prisma/client";

/**
 * Agent Journal + State — the agent's persistent memory.
 *
 * Two artifacts:
 * 1. AgentJournal rows — structured, timestamped events with reasons.
 *    DECISION | TRADE_OPEN | TRADE_CLOSE | STRATEGY_CHANGE | BACKTEST |
 *    INCIDENT | LESSON | GOAL_UPDATE
 * 2. AGENT_STATE.md — rewritten after every cycle into the agent's
 *    workspace. The tick prompt forces the CLI to read it BEFORE any
 *    decision, so a restarted agent always resumes with full context.
 */

export type JournalType =
  | "DECISION" | "TRADE_OPEN" | "TRADE_CLOSE" | "STRATEGY_CHANGE"
  | "BACKTEST" | "INCIDENT" | "LESSON" | "GOAL_UPDATE"
  | "FORECAST" | "DAILY_PLAN" | "DAILY_STATE_CHANGE" | "MODEL_UPDATE";

export async function journalWrite(
  agentId: string,
  type: JournalType,
  summary: string,
  opts: { reason?: string; data?: unknown; strategyId?: string; versionId?: string } = {},
): Promise<void> {
  try {
    await prisma.agentJournal.create({
      data: {
        agentId, type,
        summary: summary.slice(0, 2000),
        reason: opts.reason?.slice(0, 2000) ?? null,
        data: opts.data !== undefined ? JSON.stringify(opts.data).slice(0, 8000) : null,
        strategyId: opts.strategyId ?? null,
        versionId: opts.versionId ?? null,
      },
    });
  } catch (e) {
    // journal writes must never break the trading loop
    logger.warn("journal write failed", { module: "agent", agentId, error: String(e).slice(0, 120) });
  }
}

export function journalRecent(agentId: string, take = 50, type?: JournalType) {
  return prisma.agentJournal.findMany({
    where: { agentId, ...(type ? { type } : {}) },
    orderBy: { createdAt: "desc" },
    take,
  });
}

// ---------------------------------------------------------------------------
// AGENT_STATE.md — the bootstrap file the CLI reads at the top of every cycle
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = () => process.env.AGENT_WORKSPACE_DIR ?? path.join(process.cwd(), "data", "agents");

interface ManagedRow { symbol: string; strategyId?: string | null; liveStrategyId?: string | null }

export async function writeAgentState(agent: TradingAgent): Promise<void> {
  try {
    const managed = parseJson<ManagedRow[]>(agent.managed, []);
    const liveIds = managed.map((m) => m.liveStrategyId).filter(Boolean) as string[];

    const dayAgo = new Date(Date.now() - 86_400_000);
    const [lives, open, closed24, lessons, backtests, lastEvents] = await Promise.all([
      liveIds.length
        ? prisma.liveStrategy.findMany({
            where: { id: { in: liveIds } },
            include: { version: { select: { versionNumber: true, kind: true } } },
          })
        : [],
      liveIds.length ? prisma.trade.findMany({ where: { liveStrategyId: { in: liveIds }, status: "OPEN" } }) : [],
      liveIds.length
        ? prisma.trade.findMany({ where: { liveStrategyId: { in: liveIds }, status: "CLOSED", closedAt: { gte: dayAgo } } })
        : [],
      journalRecent(agent.id, 10, "LESSON"),
      prisma.backtest.findMany({
        where: { userId: agent.userId, idempotencyKey: { startsWith: `agent-${agent.id}` } },
        orderBy: { createdAt: "desc" }, take: 3,
        select: { symbol: true, status: true, profitPct: true, winRate: true, totalTrades: true, passed: true, hypothesis: true },
      }),
      journalRecent(agent.id, 15),
    ]);

    const realized = closed24.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const capital = lives.reduce((s, l) => s + l.allocatedCapital, 0);
    const pct = capital > 0 ? (realized / capital) * 100 : 0;
    const wins = closed24.filter((t) => (t.pnl ?? 0) > 0).length;

    // daily plan + forecast status for the bootstrap file
    const utcDay = new Date(); utcDay.setUTCHours(0, 0, 0, 0);
    const [plan, activeModels, resolved24] = await Promise.all([
      prisma.dailyPlan.findUnique({ where: { agentId_date: { agentId: agent.id, date: utcDay } } }),
      prisma.modelVersion.findMany({
        where: { active: true, symbolScope: { in: managed.map((m) => m.symbol) } },
        select: { horizon: true, symbolScope: true, liveAccuracy: true },
      }),
      prisma.prediction.findMany({
        where: { resolvedAt: { gte: dayAgo }, outcome: { in: ["WIN", "LOSS"] } },
        select: { outcome: true },
      }),
    ]);
    const acc24 = resolved24.length
      ? (resolved24.filter((p) => p.outcome === "WIN").length / resolved24.length) * 100 : null;
    const planStateFa: Record<string, string> = {
      BUILDING: "در حال ساخت", PROTECTING: "محافظت از سود", LOCKED: "قفل", DEFENSIVE: "دفاعی",
    };
    const note = plan?.forecastNote ? parseJson<{ summary?: string }>(plan.forecastNote, {}) : null;

    const hypothesis = lives.flatMap((l) => {
      const st = parseJson<{ improve?: { hypothesis?: string; phase?: string } }>(l.stats, {});
      return st.improve?.hypothesis ? [`- ${l.symbol}: ${st.improve.hypothesis} (فاز: ${st.improve.phase ?? "?"})`] : [];
    });

    const liveLines = lives.map((l) => {
      const m = managed.find((x) => x.liveStrategyId === l.id);
      return `- ${l.symbol}: ${l.status} · ${l.mode} · نسخه v${l.version?.versionNumber ?? "?"} (${l.version?.kind ?? "?"})${l.sizeScale < 1 ? ` · سایز آزمایشی ×${l.sizeScale}` : ""}${m?.strategyId ? ` · strategy ${m.strategyId}` : ""}`;
    });

    const openLines = open.map((t) =>
      `- ${t.symbol} ${t.side} @ ${t.entryPrice} · SL ${t.stopLossPrice ?? "?"} · TP ${t.takeProfitPrice ?? "?"} · از ${t.openedAt.toISOString()}`);

    const md = `# وضعیت ایجنت — ${new Date().toISOString()}

## هدف
هدف تلاشی: سود خالص ≥ ۵٪ در ۲۴ ساعت (بهینه‌سازی، نه با ریسک بی‌رویه). هدف واقع‌بینانه: سود مثبت پایدار با دراوداون کنترل‌شده.

## پیشرفت ۲۴ ساعت گذشته
- PnL تحقق‌یافته: ${realized.toFixed(2)} (${pct.toFixed(2)}٪ از ${capital.toFixed(0)} سرمایه)
- معاملات بسته: ${closed24.length} (${wins} برد / ${closed24.length - wins} باخت)
- پوزیشن‌های باز: ${open.length}

## برنامه‌ی امروز (DailyPlan)
${plan ? `- حالت: ${planStateFa[plan.state] ?? plan.state} · PnL امروز: ${plan.realizedPnlPct.toFixed(2)}٪ · اوج: ${plan.peakPnlPct.toFixed(2)}٪ · معاملات امروز: ${plan.tradesToday}/${plan.maxTrades}
- اهداف: حداقل ${plan.targetMin}٪ · معمول ${plan.targetNormal}٪ · تلاشی ${plan.targetStretch}٪${plan.lockedReason ? ` · دلیل قفل: ${plan.lockedReason}` : ""}
- پیش‌بینی روز: ${note?.summary ?? "—"}` : "- هنوز ساخته نشده — در اولین چرخه ساخته می‌شود"}

## مدل پیش‌بینی
${activeModels.length ? activeModels.map((m) => `- ${m.symbolScope} · افق ${m.horizon}${m.liveAccuracy != null ? ` · دقت زنده ${(m.liveAccuracy * 100).toFixed(0)}٪` : ""}`).join("\n") : "- مدل فعالی نیست — آستانه‌ی صداقت پاس نشده یا هنوز آموزش ندیده"}
- دقت پیش‌بینی‌های ۲۴ ساعت: ${acc24 !== null ? `${acc24.toFixed(0)}٪ (${resolved24.length} مورد)` : "داده‌ی کافی نیست"}

## استراتژی‌های فعال
${liveLines.length ? liveLines.join("\n") : "- هنوز استراتژی فعالی نیست — از scan_pairs شروع کن"}

## فرضیه در حال آزمون
${hypothesis.length ? hypothesis.join("\n") : "- هیچ"}

## پوزیشن‌های باز
${openLines.length ? openLines.join("\n") : "- هیچ"}

## آخرین درس‌ها
${lessons.length ? lessons.map((l) => `- ${l.summary}`).join("\n") : "- هنوز درسی ثبت نشده"}

## آخرین بک‌تست‌ها
${backtests.length ? backtests.map((b) => `- ${b.symbol}: ${b.status} · سود ${b.profitPct?.toFixed(2) ?? "?"}٪ · ${b.totalTrades ?? "?"} معامله${b.passed === true ? " · ✓ پذیرفته" : b.passed === false ? " · ✗ رد شده" : ""}${b.hypothesis ? ` · فرضیه: ${b.hypothesis}` : ""}`).join("\n") : "- هیچ"}

## آخرین رویدادها
${lastEvents.slice(0, 10).map((e) => `- [${e.createdAt.toISOString().slice(5, 16)}] ${e.type}: ${e.summary}`).join("\n") || "- هیچ"}

## جفت‌ارزهای تحت مدیریت
${managed.map((m) => `- ${m.symbol}`).join("\n") || "- هیچ — از scan_pairs شروع کن"}
`;

    const dir = path.join(WORKSPACE_ROOT(), agent.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AGENT_STATE.md"), md);
  } catch (e) {
    logger.warn("agent state write failed", { module: "agent", agentId: agent.id, error: String(e).slice(0, 120) });
  }
}
