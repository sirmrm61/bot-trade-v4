import { describe, it, expect, vi, afterAll } from "vitest";
import { prisma } from "@/infrastructure/database/prisma";
import { createAgent, stopAgent, listAgents, agentLogs } from "@/modules/agent/service";
import { AppError } from "@/shared/errors";

vi.mock("@/infrastructure/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogSink: vi.fn(),
}));
// no real redis / CLI in unit tests
vi.mock("@/infrastructure/redis/client", () => ({
  redis: { set: vi.fn(async () => "OK"), del: vi.fn(), get: vi.fn(async () => null) },
  createRedisConnection: vi.fn(),
  WORKER_HEARTBEAT_KEY: "k", WORKER_INFO_KEY: "k", WORKER_SHUTDOWN_KEY: "k",
}));

const SYM = `AGT-${Date.now() % 100000}`;
let userId = "";

const makeUser = async () => {
  const u = await prisma.user.create({
    data: { username: SYM, passwordHash: "x", referralCode: SYM },
  });
  userId = u.id;
};
const makePair = (symbol: string, exchange = "NOBITEX") =>
  prisma.pair.create({
    data: { symbol, baseCurrency: "X", quoteCurrency: "USDT", exchange },
  });

afterAll(async () => {
  await prisma.tradingAgentLog.deleteMany({ where: { agent: { userId } } });
  await prisma.tradingAgent.deleteMany({ where: { userId } });
  await prisma.pair.deleteMany({ where: { symbol: { startsWith: SYM } } });
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
});

describe("createAgent", () => {
  it("creates a RUNNING agent with defaults and an INFO log", async () => {
    await makeUser();
    await makePair(`${SYM}A-USDT`);
    const a = await createAgent(userId, { symbol: `${SYM}A-USDT` });
    expect(a.status).toBe("RUNNING");
    expect(a.mode).toBe("PAPER");
    expect(a.tickIntervalSec).toBe(600);
    const logs = await agentLogs(a.id);
    expect(logs.length).toBe(1);
    expect(logs[0].level).toBe("INFO");
  });

  it("rejects an unknown pair", async () => {
    await expect(createAgent(userId, { symbol: "NOPE-XYZ" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a second live agent on the same symbol+mode", async () => {
    await expect(createAgent(userId, { symbol: `${SYM}A-USDT` })).rejects.toMatchObject({ code: "VALIDATION" });
    // a different mode on the same symbol is a separate session — allowed
    const real = await createAgent(userId, { symbol: `${SYM}A-USDT`, mode: "REAL" });
    expect(real.mode).toBe("REAL");
  });

  it("clamps tickIntervalSec to the 60s floor", async () => {
    await makePair(`${SYM}B-USDT`);
    const a = await createAgent(userId, { symbol: `${SYM}B-USDT`, tickIntervalSec: 5 });
    expect(a.tickIntervalSec).toBe(60);
  });
});

describe("stopAgent", () => {
  it("sets STOPPED + stoppedAt and writes an ACTION log", async () => {
    const a = await createAgent(userId, { symbol: `${SYM}A-USDT`, mode: "PAPER", tickIntervalSec: 120 })
      .catch(() => prisma.tradingAgent.findFirstOrThrow({ where: { userId, symbol: `${SYM}A-USDT`, mode: "PAPER" } }));
    const stopped = await stopAgent(userId, a.id);
    expect(stopped.status).toBe("STOPPED");
    expect(stopped.stoppedAt).not.toBeNull();
    const log = (await agentLogs(a.id)).find((l) => l.level === "ACTION");
    expect(log?.message).toContain("متوقف");
  });

  it("rejects stopping another user's agent", async () => {
    const other = await prisma.user.create({ data: { username: `o${SYM}`, passwordHash: "x", referralCode: `o${SYM}` } });
    const a = await prisma.tradingAgent.findFirstOrThrow({ where: { userId } });
    await expect(stopAgent(other.id, a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.user.delete({ where: { id: other.id } });
  });

  it("revives the stopped row instead of violating the unique key", async () => {
    const revived = await createAgent(userId, { symbol: `${SYM}A-USDT`, mode: "PAPER", tickIntervalSec: 300 });
    expect(revived.status).toBe("RUNNING");
    expect(revived.tickIntervalSec).toBe(300);
    // still exactly one row for this user+symbol+mode
    const count = await prisma.tradingAgent.count({ where: { userId, symbol: `${SYM}A-USDT`, mode: "PAPER" } });
    expect(count).toBe(1);
  });
});

describe("listing", () => {
  it("listAgents returns newest first with latest log", async () => {
    const list = await listAgents(userId);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].logs?.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].createdAt >= list[i].createdAt).toBe(true);
    }
  });
});
