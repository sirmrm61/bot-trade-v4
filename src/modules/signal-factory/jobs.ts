import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import type { JournalType } from "@/modules/agent/journal";

/**
 * Job registry wrapper — every scheduled signal-factory job runs through
 * jobRun so failures are durable: lastError + failCount on the row, and after
 * 3 consecutive failures the job is disabled, an Incident is created, and the
 * event lands in the agent journal.
 */

const SYSTEM_AGENT_SYMBOL = "SIGNAL_FACTORY";

/**
 * Per-user system agent — carries journal entries for infrastructure jobs
 * (watchdog, scanners). Status "SYSTEM" keeps it out of runAgentCycle and the
 * daily-plan loop, which only look at RUNNING/PAUSED agents.
 */
export async function systemAgentId(userId: string): Promise<string> {
  const agent = await prisma.tradingAgent.upsert({
    where: { userId_symbol_mode: { userId, symbol: SYSTEM_AGENT_SYMBOL, mode: "PAPER" } },
    create: { userId, symbol: SYSTEM_AGENT_SYMBOL, mode: "PAPER", status: "SYSTEM" },
    update: {},
  });
  return agent.id;
}

async function jobJournal(
  opts: { userId?: string; agentId?: string },
  type: JournalType,
  summary: string,
  extra: { reason?: string; data?: unknown } = {},
): Promise<void> {
  try {
    const agentId = opts.agentId ?? (opts.userId ? await systemAgentId(opts.userId) : null);
    if (!agentId) return;
    const { journalWrite } = await import("@/modules/agent/journal");
    await journalWrite(agentId, type, summary, extra);
  } catch (e) {
    logger.warn("job journal failed", { module: "signal-factory", errorCode: String(e).slice(0, 120) });
  }
}

export interface JobRunOpts {
  userId?: string;
  agentId?: string;
  kind?: "INTERVAL" | "BULLMQ";
  createdBy?: string;
}

const MAX_CONSECUTIVE_FAILURES = 3;

export async function jobRun<T>(
  name: string,
  schedule: string,
  fn: () => Promise<T>,
  opts: JobRunOpts = {},
): Promise<T | undefined> {
  let reg = await prisma.jobRegistry.findUnique({ where: { name } });
  if (!reg) {
    reg = await prisma.jobRegistry.create({
      data: { name, schedule, kind: opts.kind ?? "INTERVAL", createdBy: opts.createdBy ?? "system" },
    });
    await jobJournal(opts, "JOB_CREATED", `job «${name}» ثبت شد`, { data: { schedule } });
  }
  if (!reg.enabled) {
    logger.warn("job skipped — disabled", { module: "signal-factory", job: name });
    return undefined;
  }

  try {
    const result = await fn();
    await prisma.jobRegistry.update({
      where: { name },
      data: { lastRunAt: new Date(), lastStatus: "OK", lastError: null, failCount: 0 },
    });
    return result;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 1000);
    const failCount = reg.failCount + 1;
    const disable = failCount >= MAX_CONSECUTIVE_FAILURES;
    await prisma.jobRegistry.update({
      where: { name },
      data: {
        lastRunAt: new Date(),
        lastStatus: "FAILED",
        lastError: msg,
        failCount,
        ...(disable ? { enabled: false, reason: `${MAX_CONSECUTIVE_FAILURES} خطای پیاپی` } : {}),
      },
    });
    logger.error("job failed", { module: "signal-factory", job: name, failCount, errorCode: msg });
    if (disable) {
      await prisma.incident.create({
        data: {
          userId: opts.userId ?? null,
          kind: "JOB_DISABLED",
          summary: `job «${name}» پس از ${failCount} خطای پیاپی غیرفعال شد`,
          data: JSON.stringify({ name, schedule, lastError: msg }),
        },
      });
      await jobJournal(opts, "INCIDENT", `job «${name}» پس از ${failCount} خطای پیاپی غیرفعال شد`, {
        reason: msg,
        data: { schedule },
      });
    }
    return undefined;
  }
}
