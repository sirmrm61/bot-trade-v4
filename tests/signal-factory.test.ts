import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Signal factory stage-1 test — real SQLite via the Prisma driver adapter.
 * Applies every committed migration to a throwaway DB (the new
 * signal_factory tables only exist after the last one).
 */

const TEST_DB = path.join(process.cwd(), "test-signal-factory.db");
process.env.DATABASE_URL = `file:./test-signal-factory.db`;
process.env.ENCRYPTION_KEY ??= "a".repeat(64);

let prisma: Awaited<typeof import("@/infrastructure/database/prisma")>["prisma"];
let getOrCreateConfig: Awaited<typeof import("@/modules/signal-factory/config")>["getOrCreateConfig"];
let updateConfig: Awaited<typeof import("@/modules/signal-factory/config")>["updateConfig"];
let pairFilter: Awaited<typeof import("@/modules/signal-factory/config")>["pairFilter"];
let pairVolume24h: Awaited<typeof import("@/modules/signal-factory/config")>["pairVolume24h"];
let isStale: Awaited<typeof import("@/modules/signal-factory/data")>["isStale"];
let assertFresh: Awaited<typeof import("@/modules/signal-factory/data")>["assertFresh"];
let jobRun: Awaited<typeof import("@/modules/signal-factory/jobs")>["jobRun"];

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const dir = path.join(process.cwd(), "prisma", "migrations");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(TEST_DB);
  for (const m of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()) {
    db.exec(fs.readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
  }
  db.close();

  ({ prisma } = await import("@/infrastructure/database/prisma"));
  ({ getOrCreateConfig, updateConfig, pairFilter, pairVolume24h } = await import("@/modules/signal-factory/config"));
  ({ isStale, assertFresh } = await import("@/modules/signal-factory/data"));
  ({ jobRun } = await import("@/modules/signal-factory/jobs"));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("signal-factory config", () => {
  it("creates a config with spec defaults on first access", async () => {
    const user = await prisma.user.create({
      data: { username: "sfuser", passwordHash: "x", referralCode: "SF1" },
    });
    const cfg = await getOrCreateConfig(user.id);
    expect(cfg.exchange).toBe("KUCOIN");
    expect(cfg.marketType).toBe("SPOT");
    expect(cfg.quote).toBe("USDT");
    expect(cfg.minVolume24h).toBe(0);
    expect(JSON.parse(cfg.timeframes)).toEqual(["4h", "1h", "1d"]);
    expect(cfg.scanEveryHours).toBe(4);
    expect(cfg.enabled).toBe(true);
    expect(cfg.liveTradingEnabled).toBe(false);
    // idempotent — same row back
    expect((await getOrCreateConfig(user.id)).id).toBe(cfg.id);
  });

  it("updates validated fields and rejects bad values", async () => {
    const user = await prisma.user.create({
      data: { username: "sfuser2", passwordHash: "x", referralCode: "SF2" },
    });
    const cfg = await updateConfig(user.id, {
      exchange: "nobitex",
      marketType: "futures",
      quote: "usdt",
      minVolume24h: 5000,
      scanEveryHours: 2,
      timeframes: ["1h", "4h"],
    });
    expect(cfg.exchange).toBe("NOBITEX");
    expect(cfg.marketType).toBe("FUTURES");
    expect(cfg.quote).toBe("USDT");
    expect(cfg.minVolume24h).toBe(5000);
    await expect(updateConfig(user.id, { exchange: "BINANCE" })).rejects.toThrow();
    await expect(updateConfig(user.id, { timeframes: ["9h"] })).rejects.toThrow();
    await expect(updateConfig(user.id, { minVolume24h: -1 })).rejects.toThrow();
  });
});

describe("pairFilter", () => {
  const pair = (over: Record<string, unknown>) => ({
    exchange: "KUCOIN",
    quoteCurrency: "USDT",
    active: true,
    metadata: null,
    ...over,
  }) as never;

  it("keeps active pairs on the configured exchange+quote above the volume floor", async () => {
    const pairs = [
      pair({ symbol: "BTC-USDT", metadata: JSON.stringify({ vol: "100000" }) }),
      pair({ symbol: "ETH-USDT", metadata: JSON.stringify({ volume24h: 500 }) }),
      pair({ symbol: "XRP-USDT", active: false, metadata: JSON.stringify({ vol: "999999" }) }),
      pair({ symbol: "BTC-EUR", quoteCurrency: "EUR", metadata: JSON.stringify({ vol: "999999" }) }),
      pair({ symbol: "LTC-USDT", exchange: "NOBITEX", metadata: JSON.stringify({ vol: "999999" }) }),
      pair({ symbol: "DUST-USDT", metadata: JSON.stringify({ vol: "10" }) }),
      pair({ symbol: "NOVOL-USDT" }),
    ];
    const cfg = { exchange: "KUCOIN", quote: "USDT", minVolume24h: 1000 };
    const out = await pairFilter(cfg, pairs);
    expect(out.map((p) => p.symbol)).toEqual(["BTC-USDT"]);
  });

  it("passes everything matching exchange/quote when minVolume24h is 0", async () => {
    const pairs = [pair({ symbol: "BTC-USDT" }), pair({ symbol: "DUST-USDT" })];
    const out = await pairFilter({ exchange: "KUCOIN", quote: "USDT", minVolume24h: 0 }, pairs);
    expect(out).toHaveLength(2);
  });

  it("reads volume from known metadata keys", () => {
    expect(pairVolume24h({ metadata: JSON.stringify({ volumeSrc: "42.5" }) } as never)).toBe(42.5);
    expect(pairVolume24h({ metadata: JSON.stringify({ foo: 1 }) } as never)).toBe(0);
    expect(pairVolume24h({ metadata: "not json" } as never)).toBe(0);
  });
});

describe("candle freshness", () => {
  const now = Date.now();
  it("rejects a series whose newest candle is older than 2× timeframe", () => {
    const stale = [{ time: now - 3 * 60 * 60_000 }]; // 3h ago on 1h tf
    expect(isStale(stale, "1h", now)).toBe(true);
    expect(() => assertFresh(stale, "1h", now)).toThrow();
  });

  it("accepts a fresh series and rejects empty input", () => {
    const fresh = [{ time: now - 30 * 60_000 }];
    expect(isStale(fresh, "1h", now)).toBe(false);
    expect(() => assertFresh(fresh, "1h", now)).not.toThrow();
    expect(isStale([], "4h", now)).toBe(true);
    expect(() => assertFresh([], "4h", now)).toThrow();
  });
});

describe("jobRun", () => {
  it("records success then disables the job + writes an Incident after 3 failures", async () => {
    await jobRun("test-job", "5min", async () => "ok");
    let reg = await prisma.jobRegistry.findUnique({ where: { name: "test-job" } });
    expect(reg?.lastStatus).toBe("OK");

    const boom = async () => { throw new Error("boom"); };
    await jobRun("test-job", "5min", boom);
    await jobRun("test-job", "5min", boom);
    await jobRun("test-job", "5min", boom);

    reg = await prisma.jobRegistry.findUnique({ where: { name: "test-job" } });
    expect(reg?.lastStatus).toBe("FAILED");
    expect(reg?.failCount).toBe(3);
    expect(reg?.enabled).toBe(false);
    expect(reg?.lastError).toContain("boom");

    const inc = await prisma.incident.findFirst({ where: { kind: "JOB_DISABLED" } });
    expect(inc?.summary).toContain("test-job");

    // disabled jobs no longer execute
    let ran = false;
    await jobRun("test-job", "5min", async () => { ran = true; });
    expect(ran).toBe(false);
  });
});
