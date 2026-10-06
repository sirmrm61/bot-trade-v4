import { execFile } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { logger } from "@/infrastructure/logging/logger";
import { redis } from "@/infrastructure/redis/client";
import { pauseLiveStrategy } from "@/modules/trading/live-engine";

/**
 * Trading Agents — per-symbol autonomous agents powered by the local
 * Devin CLI (SWE-2). Each agent gets its own workspace directory → its
 * own CLI session history, its own skills, and its own state notes.
 *
 * Lifecycle: user creates a TradingAgent from the Smart Trader panel →
 * the worker calls runAgentCycle() every minute → due agents get a
 * single-turn `devin -p` run in their workspace; the agent talks back
 * to the app through /api/agent (Bearer AGENT_TOKEN) and reports to the
 * user via TradingAgentLog rows shown in the panel.
 */

const TICK_MIN_INTERVAL_SEC = 60;
const CLI_TIMEOUT_MS = 8 * 60_000;
const AGENT_TOKEN = () => process.env.AGENT_TOKEN ?? "";
const API_URL = () => process.env.AGENT_API_URL ?? "http://127.0.0.1:3000";
const WORKSPACE_ROOT = () => process.env.AGENT_WORKSPACE_DIR ?? path.join(process.cwd(), "data", "agents");
const TEMPLATE_DIR = () => process.env.AGENT_TEMPLATE_DIR ?? path.join(process.cwd(), "agent", "workspace");
const CLI_BIN = () => process.env.DEVIN_CLI_BIN ?? "devin";
const CLI_MODEL = () => process.env.DEVIN_CLI_MODEL ?? "swe";

export const workspaceDir = (agentId: string) => path.join(WORKSPACE_ROOT(), agentId);

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

export async function createAgent(
  userId: string,
  opts: { symbol: string; exchange?: string; mode?: "PAPER" | "REAL"; tickIntervalSec?: number },
) {
  const symbol = opts.symbol.toUpperCase();
  const exchange = (opts.exchange ?? "NOBITEX").toUpperCase();
  const mode = opts.mode ?? "PAPER";

  const pair = await prisma.pair.findFirst({ where: { symbol, exchange, active: true } });
  if (!pair) throw new AppError("VALIDATION", 400, { field: "symbol", reason: "pair not found" });

  const existing = await prisma.tradingAgent.findFirst({
    where: { userId, symbol, mode, status: { not: "STOPPED" } },
  });
  if (existing) throw new AppError("VALIDATION", 400, { field: "symbol", reason: "agent already running for this symbol" });

  const running = await prisma.tradingAgent.count({ where: { userId, status: "RUNNING" } });
  if (running >= 5) throw new AppError("VALIDATION", 400, { reason: "حداکثر ۵ ایجنت هم‌زمان مجاز است" });

  // the unique (userId, symbol, mode) key survives a stop — revive the old
  // row (fresh workspace links, reset error state) instead of failing
  const stopped = await prisma.tradingAgent.findFirst({
    where: { userId, symbol, mode, status: "STOPPED" },
  });
  const agent = stopped
    ? await prisma.tradingAgent.update({
        where: { id: stopped.id },
        data: {
          status: "RUNNING", lastError: null, lastTickAt: null, stoppedAt: null,
          exchange, tickIntervalSec: Math.max(TICK_MIN_INTERVAL_SEC, opts.tickIntervalSec ?? 600),
        },
      })
    : await prisma.tradingAgent.create({
        data: {
          userId, symbol, exchange, mode,
          tickIntervalSec: Math.max(TICK_MIN_INTERVAL_SEC, opts.tickIntervalSec ?? 600),
        },
      });
  provisionWorkspace(agent.id);
  await agentLog(agent.id, "INFO",
    `ایجنت برای ${symbol} (${exchange}) در حالت ${mode === "PAPER" ? "تست زنده" : "واقعی"} ساخته شد — اولین بررسی به‌زودی انجام می‌شود.`);
  return agent;
}

export async function stopAgent(userId: string, agentId: string) {
  const agent = await prisma.tradingAgent.findFirst({ where: { id: agentId, userId } });
  if (!agent) throw new AppError("NOT_FOUND", 404);
  if (agent.status === "STOPPED") return agent;
  const updated = await prisma.tradingAgent.update({
    where: { id: agent.id },
    data: { status: "STOPPED", stoppedAt: new Date() },
  });
  // pause the managed live strategy so no new entries fire — open trades
  // keep being managed by the engine's SL/TP loop
  if (agent.liveStrategyId) {
    await pauseLiveStrategy(userId, agent.liveStrategyId).catch(() => {});
  }
  await agentLog(agent.id, "ACTION", "ایجنت توسط کاربر متوقف شد.");
  return updated;
}

export function listAgents(userId: string) {
  return prisma.tradingAgent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      logs: { orderBy: { createdAt: "desc" }, take: 1 },
      strategy: { select: { id: true, name: true } },
    },
  });
}

export const agentLogs = (agentId: string, take = 100) =>
  prisma.tradingAgentLog.findMany({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    take,
  });

export async function agentLog(agentId: string, level: string, message: string) {
  await prisma.tradingAgentLog.create({
    data: { agentId, level, message: message.slice(0, 2000) },
  });
}

// ---------------------------------------------------------------------------
// workspace provisioning — each agent gets .devin/skills + AGENTS.md + state.md
// ---------------------------------------------------------------------------

/** copy the bundled skill template into the agent workspace.
 *  Runs every tick — the .devin skill dir is re-synced so template updates
 *  reach existing agents without wiping their state.md/session history. */
export function provisionWorkspace(agentId: string) {
  const dir = workspaceDir(agentId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tpl = TEMPLATE_DIR();
  if (existsSync(tpl)) {
    const skills = path.join(tpl, ".devin");
    if (existsSync(skills)) cpSync(skills, path.join(dir, ".devin"), { recursive: true });
    if (!existsSync(path.join(dir, "AGENTS.md"))) cpSync(path.join(tpl, "AGENTS.md"), path.join(dir, "AGENTS.md"));
    if (!existsSync(path.join(dir, "state.md"))) cpSync(path.join(tpl, "state.md"), path.join(dir, "state.md"));
  }
  ensureDevinCredentials();
  return dir;
}

/** seed CLI auth from the mounted credentials file (container: read-only mount).
 *  The CLI reads credentials from $XDG_DATA_HOME/devin/credentials.toml
 *  (≈ $HOME/.local/share/devin/) — NOT ~/.config. */
export function ensureDevinCredentials() {
  const src = process.env.DEVIN_CREDENTIALS_SRC;
  if (src && existsSync(src)) {
    const home = process.env.HOME ?? "/root";
    const destDir = path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "devin");
    const dest = path.join(destDir, "credentials.toml");
    if (!existsSync(dest)) {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, dest);
    }
  }
  // non-interactive workers can't "trust" a workspace — disable the gate once
  // in the user-level CLI config ($HOME/.config/devin/config.json)
  const home = process.env.HOME ?? "/root";
  const cfgDir = path.join(home, ".config", "devin");
  const cfgPath = path.join(cfgDir, "config.json");
  try {
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
    if (cfg.respect_workspace_trust !== false) {
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(cfgPath, JSON.stringify({ ...cfg, respect_workspace_trust: false }, null, 2));
    }
  } catch {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ respect_workspace_trust: false }, null, 2));
  }
}

// ---------------------------------------------------------------------------
// the review cycle — spawned by the worker every minute
// ---------------------------------------------------------------------------

const TICK_PROMPT = `Perform your scheduled trading review now.

Follow the workflow in AGENTS.md exactly:
1. Read state.md for your standing plan.
2. Call market_summary, list_trades and list_strategies via the agent API.
3. Decide: manage open trades, tune the strategy, or open/close a position — only if evidence supports it.
4. If no strategy exists yet, create one that fits the current market regime.
5. Write your actions and reasoning to state.md.
6. Finish by calling the "log" action with a concise Persian summary for the user panel (what you checked, what you did, why — and what you'll watch next).

Rules: never trade without a clear setup, never increase position size beyond the strategy's risk settings, and if nothing is worth doing say so — a HOLD decision is a valid outcome.`;

/** is a CLI run already in flight for this agent? (cross-process guard) */
const lockKey = (agentId: string) => `agent:lock:${agentId}`;

export async function agentTick(agentId: string) {
  const agent = await prisma.tradingAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.status !== "RUNNING") return;

  const got = await redis.set(lockKey(agentId), "1", "EX", CLI_TIMEOUT_MS / 1000 + 60, "NX");
  if (!got) return; // previous review still running

  const dir = provisionWorkspace(agentId);
  const continued = existsSync(path.join(dir, ".devin-session-started"));

  try {
    const args = [
      "--model", CLI_MODEL(),
      "--permission-mode", "bypass",
      "--respect-workspace-trust", "false",
      ...(continued ? ["-c"] : []),
      "-p", TICK_PROMPT,
    ];
    const out = await runCli(dir, args);
    writeFileSync(path.join(dir, ".devin-session-started"), "1");
    const tail = out.trim().split("\n").slice(-6).join("\n").slice(0, 1500);
    await prisma.tradingAgent.update({
      where: { id: agentId },
      data: { lastTickAt: new Date(), lastError: null, status: "RUNNING" },
    });
    if (tail) await agentLog(agentId, "INFO", `پایان بررسی — خروجی ایجنت:\n${tail}`);
  } catch (e) {
    const msg = String(e).slice(0, 800);
    await prisma.tradingAgent.update({
      where: { id: agentId },
      data: { lastTickAt: new Date(), lastError: msg },
    });
    await agentLog(agentId, "ERROR", `خطا در اجرای بررسی ایجنت: ${msg}`);
    logger.warn("agent tick failed", { module: "agent", agentId, error: msg });
  } finally {
    await redis.del(lockKey(agentId)).catch(() => {});
  }
}

/** one review pass over every due agent — called by the worker scheduler */
export async function runAgentCycle() {
  const all = await prisma.tradingAgent.findMany({
    where: { status: "RUNNING" },
    select: { id: true, lastTickAt: true, tickIntervalSec: true },
  });
  const now = Date.now();
  const ids = all
    .filter((a) => !a.lastTickAt || now - a.lastTickAt.getTime() >= a.tickIntervalSec * 1000)
    .map((a) => a.id);
  for (const id of ids) {
    await agentTick(id).catch((e) => logger.warn("agent cycle error", { module: "agent", agentId: id, error: String(e).slice(0, 120) }));
  }
  return ids.length;
}

function runCli(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      CLI_BIN(),
      args,
      {
        cwd,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          AGENT_TOKEN: AGENT_TOKEN(),
          AGENT_API_URL: API_URL(),
          AGENT_ID: cwd.split(path.sep).pop() ?? "",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = [stdout, stderr].filter(Boolean).join("\n").slice(-1000);
          reject(new Error(detail || err.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
