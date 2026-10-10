import { prisma } from "@/infrastructure/database/prisma";
import { parseJson } from "@/shared/utils";

/**
 * Hard safety guardrails — constants, NOT strategy config. The agent and
 * the self-improvement loop can never loosen these; they exist outside
 * the prompt and outside version config. Every entry (paper or real)
 * passes through checkEntryGuardrails() before an order is considered.
 */
export const GUARDRAILS = {
  /** max % of allocated capital risked on one trade */
  MAX_RISK_PER_TRADE_PCT: 1,
  /** realized loss in a rolling 24h that halts new entries until tomorrow */
  DAILY_LOSS_LIMIT_PCT: 3,
  /** total drawdown from peak equity that pauses the agent entirely */
  MAX_DRAWDOWN_PCT: 10,
  /** agent-managed futures positions — user-approved hard cap */
  AGENT_MAX_LEVERAGE: 2,
  /** spot is always 1× */
  SPOT_LEVERAGE: 1,
  /** concurrent open positions across the agent's managed lives */
  MAX_CONCURRENT_POSITIONS: 3,
  /** every entry must carry a stop-loss */
  REQUIRE_STOP_LOSS: true,
  /** minimum reward:risk to justify an entry */
  MIN_RISK_REWARD: 1.5,
  /** composite signal-quality floor for entries */
  MIN_SIGNAL_SCORE: 0.5,
} as const;

export interface GuardrailVerdict {
  allow: boolean;
  code?: "DAILY_LOSS" | "DRAWDOWN" | "MAX_POSITIONS" | "NO_STOP" | "LOW_RR" | "LOW_SCORE";
  reason?: string;
}

interface LiveForGuard {
  id: string;
  userId: string;
  stats: string;
  allocatedCapital: number;
}

const dayAgo = () => new Date(Date.now() - 86_400_000);

/** realized PnL of a live's trades closed in the last 24h */
async function realizedPnl24h(liveStrategyId: string): Promise<number> {
  const rows = await prisma.trade.findMany({
    where: { liveStrategyId, status: "CLOSED", closedAt: { gte: dayAgo() } },
    select: { pnl: true },
  });
  return rows.reduce((s, t) => s + (t.pnl ?? 0), 0);
}

interface GuardStats {
  haltUntil?: number;   // epoch ms — entries blocked until then (daily-loss breaker)
  peakEquity?: number;  // high-water mark of allocated + cumulative realized pnl
}

/**
 * Per-live hard rules. Runs for BOTH paper and real — the agent trades
 * paper first and must learn inside the same fences it will face live.
 *
 * Order matters: cheap checks first, DB reads last.
 */
export async function checkEntryGuardrails(
  live: LiveForGuard,
  opts: { agentId?: string; slPct?: number; tpPct?: number; score?: number } = {},
): Promise<GuardrailVerdict> {
  const stats = parseJson<GuardStats>(live.stats, {});

  // daily-loss circuit — active hold?
  if (stats.haltUntil && Date.now() < stats.haltUntil) {
    return { allow: false, code: "DAILY_LOSS", reason: "سیرکیت‌بریکر زیان روزانه فعال است" };
  }

  // every entry must carry a stop-loss
  if (GUARDRAILS.REQUIRE_STOP_LOSS && !(opts.slPct && opts.slPct > 0)) {
    return { allow: false, code: "NO_STOP", reason: "معامله بدون حد ضرر مجاز نیست" };
  }

  // reward:risk floor — only when both legs are known
  if (opts.slPct && opts.tpPct && opts.tpPct > 0) {
    const rr = opts.tpPct / opts.slPct;
    if (rr < GUARDRAILS.MIN_RISK_REWARD) {
      return { allow: false, code: "LOW_RR", reason: `نسبت ریسک به ریوارد ${rr.toFixed(2)} < ${GUARDRAILS.MIN_RISK_REWARD}` };
    }
  }

  // composite signal quality
  if (opts.score !== undefined && opts.score < GUARDRAILS.MIN_SIGNAL_SCORE) {
    return { allow: false, code: "LOW_SCORE", reason: `امتیاز سیگنال ${opts.score.toFixed(2)} < ${GUARDRAILS.MIN_SIGNAL_SCORE}` };
  }

  // realized 24h loss ≥ 3% of allocated → halt until next UTC day
  const day = await realizedPnl24h(live.id);
  const dayLossPct = live.allocatedCapital > 0 ? (-day / live.allocatedCapital) * 100 : 0;
  if (dayLossPct >= GUARDRAILS.DAILY_LOSS_LIMIT_PCT) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { stats: JSON.stringify({ ...stats, haltUntil: tomorrow.getTime() }) },
    }).catch(() => {});
    return { allow: false, code: "DAILY_LOSS", reason: `زیان تحقق‌یافته‌ی ۲۴ساعت ${dayLossPct.toFixed(2)}٪ از سقف ${GUARDRAILS.DAILY_LOSS_LIMIT_PCT}٪ گذشت` };
  }

  // max drawdown — equity vs its high-water mark
  const allClosed = await prisma.trade.findMany({
    where: { liveStrategyId: live.id, status: "CLOSED" },
    select: { pnl: true },
  });
  const cum = allClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const equity = live.allocatedCapital + cum;
  const peak = Math.max(stats.peakEquity ?? live.allocatedCapital, equity);
  const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  if (peak !== stats.peakEquity) {
    await prisma.liveStrategy.update({
      where: { id: live.id },
      data: { stats: JSON.stringify({ ...stats, peakEquity: peak }) },
    }).catch(() => {});
  }
  if (ddPct >= GUARDRAILS.MAX_DRAWDOWN_PCT) {
    return { allow: false, code: "DRAWDOWN", reason: `دراوداون ${ddPct.toFixed(1)}٪ از سقف ${GUARDRAILS.MAX_DRAWDOWN_PCT}٪ گذشت` };
  }

  // concurrent open positions across the agent's managed set
  if (opts.agentId) {
    const agent = await prisma.tradingAgent.findUnique({
      where: { id: opts.agentId }, select: { managed: true },
    });
    let liveIds: string[] = [];
    try {
      liveIds = (JSON.parse(agent?.managed ?? "[]") as { liveStrategyId?: string }[])
        .map((m) => m.liveStrategyId).filter(Boolean) as string[];
    } catch { /* malformed managed json — fall back to this live only */ }
    if (!liveIds.length) liveIds = [live.id];
    const openCount = await prisma.trade.count({
      where: { liveStrategyId: { in: liveIds }, status: "OPEN" },
    });
    if (openCount >= GUARDRAILS.MAX_CONCURRENT_POSITIONS) {
      return { allow: false, code: "MAX_POSITIONS", reason: `سقف ${GUARDRAILS.MAX_CONCURRENT_POSITIONS} پوزیشن هم‌زمان` };
    }
  }

  return { allow: true };
}

/**
 * Drawdown breach → agent PAUSED for review (no auto-resume — a 10%
 * drawdown needs human eyes). Recreate/confirm the agent to resume it.
 */
export async function pauseAgentOnDrawdown(agentId: string, summary: string): Promise<void> {
  const agent = await prisma.tradingAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.status !== "RUNNING") return;
  await prisma.tradingAgent.update({
    where: { id: agentId },
    data: { status: "PAUSED" },
  });
  await prisma.tradingAgentLog.create({
    data: { agentId, level: "ERROR", message: summary.slice(0, 2000) },
  });
}
