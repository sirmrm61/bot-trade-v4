import { TEST_DB } from "./sf-stats-env";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "@/modules/exchanges/types";
import {
  hypotheticalOutcome, runOutcomeTracker, aggregateSetupType, runStatsAggregator,
  runDailyReport, shouldDegrade,
  DEGRADE_MIN_PAPER_TRADES, DEGRADE_MIN_PAPER_DAYS, DEGRADED_WEIGHT,
} from "@/modules/signal-factory/stats";
import { typeKeyOf, type SetupDraft } from "@/modules/signal-factory/setups";

/**
 * Stage-5 tests — stats aggregation math, degradation trigger boundaries,
 * outcome-tracker hypothetical evaluation, daily report, >30d setup cleanup
 * keeping PaperTrade rows (SET NULL FK), and the degraded-weight ranking.
 */

let prisma: Awaited<typeof import("@/infrastructure/database/prisma")>["prisma"];
let getOrCreateConfig: Awaited<typeof import("@/modules/signal-factory/config")>["getOrCreateConfig"];

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
  ({ getOrCreateConfig } = await import("@/modules/signal-factory/config"));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

beforeEach(async () => {
  await prisma.paperTrade.deleteMany();
  await prisma.setup.deleteMany();
  await prisma.setupType.deleteMany();
});

// ---------------------------------------------------------------------------

const STEP = 14_400_000; // 4h
const DAY = 86_400_000;
const FEE = 0.25, SLIP = 0.05;
let seq = 0;

const mk = (o: number, h: number, l: number, c: number, time: number): Candle =>
  ({ time, open: o, high: h, low: l, close: c, volume: 100 });

async function mkSetup(over: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: { username: `st${++seq}`, passwordHash: "x", referralCode: `ST${seq}` },
  });
  const cfg = await getOrCreateConfig(user.id);
  const setup = await prisma.setup.create({
    data: {
      userId: user.id, configId: cfg.id, exchange: "KUCOIN",
      symbol: `S${seq}-USDT`, marketType: "SPOT",
      direction: "LONG", kind: "LONG_BREAKOUT", typeKey: `LONG_BREAKOUT:st${seq}`,
      timeframe: "4h",
      triggerPrice: 100, confirmRule: "CLOSE_ABOVE_TF",
      entryLow: 100, entryHigh: 101, tp1: 104, tp2: 108, sl: 96,
      invalidatePrice: 95, rr: 2, score: 70, confidence: 0.7,
      reasonFa: "تست", levelsMeta: "{}", expiresAt: new Date(Date.now() - 60_000),
      priceAtScan: 99,
      ...over,
    },
  });
  return { user, cfg, setup };
}

async function mkClosedTrade(setup: { id: string; userId: string; symbol: string; typeKey: string },
  pnlPct: number, openedAt: Date) {
  await prisma.paperTrade.create({
    data: {
      setupId: setup.id, userId: setup.userId, symbol: setup.symbol,
      side: "BUY", entryPrice: 100, amount: 10, invested: 1000,
      tp1: 104, tp2: 108, sl: 96, costsPct: 0.6,
      status: "CLOSED", exitPrice: 100 + pnlPct, exitReason: pnlPct > 0 ? "TP2_HIT" : "SL_HIT",
      pnl: pnlPct * 10, pnlPct, openedAt, closedAt: new Date(openedAt.getTime() + 3_600_000),
    },
  });
  await prisma.setup.update({
    where: { id: setup.id },
    data: {
      state: "PAPER_CLOSED", closedAt: new Date(openedAt.getTime() + 3_600_000),
      outcome: pnlPct > 0 ? "TP2_HIT" : "SL_HIT", outcomePnlPct: pnlPct,
    },
  });
}

// ---------------------------------------------------------------------------
// Pure hypothetical evaluation
// ---------------------------------------------------------------------------

describe("hypotheticalOutcome", () => {
  const t0 = Date.now() - 10 * STEP;
  const setup = {
    direction: "LONG", confirmRule: "CLOSE_ABOVE_TF",
    triggerPrice: 100, entryLow: 100, entryHigh: 101,
    tp1: 104, tp2: 108, sl: 96, timeframe: "4h",
    createdAt: new Date(t0), expiresAt: new Date(t0 + 6 * STEP),
  } as never;
  const opts = { feePct: FEE, slippagePct: SLIP };

  it("trigger + TP1 + breakeven scratch → TP1_HIT with positive pnl", () => {
    const candles = [
      mk(99, 99.5, 98, 99, t0),
      mk(99, 101.2, 98.5, 101, t0 + STEP),        // confirm: close > 100
      mk(101, 101.5, 100, 101, t0 + 2 * STEP),    // entry ~101.05
      mk(101, 105, 100.5, 104.5, t0 + 3 * STEP),  // TP1 → 50% banked, SL→BE
      mk(104, 104.2, 100.9, 101.5, t0 + 4 * STEP),// BE stop hit
    ];
    const r = hypotheticalOutcome(setup, candles, opts)!;
    expect(r.triggered).toBe(true);
    expect(r.outcome).toBe("TP1_HIT");
    expect(r.pnlPct).toBeGreaterThan(0);
    expect(r.pnlPct).toBeLessThan(3);
  });

  it("trigger then straight to SL → SL_HIT with a ~full-risk loss", () => {
    const candles = [
      mk(99, 101.2, 98.5, 101, t0),
      mk(101, 101.5, 95, 96.5, t0 + STEP), // entry at open, same candle hits SL
      mk(96.5, 97, 95.5, 96.8, t0 + 2 * STEP),
    ];
    const r = hypotheticalOutcome(setup, candles, opts)!;
    expect(r.outcome).toBe("SL_HIT");
    expect(r.pnlPct).toBeLessThan(-3);
  });

  it("no confirm inside the window → EXPIRED 0, untriggered", () => {
    const candles = [
      mk(99, 99.5, 98, 99, t0), mk(99, 99.6, 98.2, 99.2, t0 + STEP),
      mk(99.2, 99.8, 98.8, 99.4, t0 + 2 * STEP),
    ];
    const r = hypotheticalOutcome(setup, candles, opts)!;
    expect(r).toEqual({ outcome: "EXPIRED", pnlPct: 0, triggered: false });
  });

  it("a confirm on the first candle AFTER expiry does not count", () => {
    const candles = [
      mk(99, 99.5, 98, 99, t0 + 5 * STEP),       // last in-window candle
      mk(99, 101.2, 98.5, 101, t0 + 6 * STEP),   // past expiresAt — kept only as fill candle
      mk(101, 105, 100, 104, t0 + 7 * STEP),     // outside series entirely
    ];
    const r = hypotheticalOutcome(setup, candles, opts)!;
    expect(r.triggered).toBe(false);
    expect(r.outcome).toBe("EXPIRED");
  });

  it("returns null when no candles cover the window", () => {
    expect(hypotheticalOutcome(setup, [mk(1, 1, 1, 1, t0 - STEP)], opts)).toBeNull();
  });
});

describe("runOutcomeTracker", () => {
  it("evaluates expired setups and writes outcome + meta.hypothetical", async () => {
    const t0 = Date.now() - 10 * STEP;
    const { setup } = await mkSetup({
      state: "EXPIRED", closedAt: new Date(t0 + 6 * STEP),
      createdAt: new Date(t0), expiresAt: new Date(t0 + 6 * STEP),
    });
    const candles = [
      mk(99, 101.2, 98.5, 101, t0),
      mk(101, 101.5, 95, 96.5, t0 + STEP),
      mk(96.5, 97, 95.5, 96.8, t0 + 2 * STEP),
    ];
    const r = await runOutcomeTracker({ fetchCandles: async () => candles, feePct: FEE, slippagePct: SLIP, now: Date.now() });
    expect(r.evaluated).toBe(1);
    expect(r.triggered).toBe(1);
    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.outcome).toBe("SL_HIT");
    expect(row?.outcomePnlPct).toBeLessThan(-3);
    expect(JSON.parse(row!.meta!).hypothetical).toBe(true);
    expect(JSON.parse(row!.meta!).triggered).toBe(true);
  });

  it("records EXPIRED 0 for setups that never triggered; skips still-active ones", async () => {
    const t0 = Date.now() - 10 * STEP;
    const { setup } = await mkSetup({
      state: "EXPIRED", closedAt: new Date(t0 + 6 * STEP),
      createdAt: new Date(t0), expiresAt: new Date(t0 + 6 * STEP),
    });
    const active = await mkSetup({ state: "WAITING_TRIGGER" }); // must not be touched
    const candles = [mk(99, 99.5, 98, 99, t0), mk(99, 99.6, 98, 99.2, t0 + STEP)];
    await runOutcomeTracker({ fetchCandles: async () => candles, feePct: FEE, slippagePct: SLIP });
    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.outcome).toBe("EXPIRED");
    expect(row?.outcomePnlPct).toBe(0);
    expect(JSON.parse(row!.meta!).triggered).toBe(false);
    expect((await prisma.setup.findUnique({ where: { id: active.setup.id } }))?.outcome).toBeNull();
  });

  it("is idempotent — evaluated setups are not re-evaluated", async () => {
    const t0 = Date.now() - 10 * STEP;
    await mkSetup({
      state: "EXPIRED", closedAt: new Date(t0 + 6 * STEP),
      createdAt: new Date(t0), expiresAt: new Date(t0 + 6 * STEP),
      outcome: "SL_HIT", outcomePnlPct: -4, meta: JSON.stringify({ hypothetical: true, triggered: true }),
    });
    const r = await runOutcomeTracker({ fetchCandles: async () => [], feePct: FEE, slippagePct: SLIP });
    expect(r.checked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregation math
// ---------------------------------------------------------------------------

describe("aggregateSetupType", () => {
  it("counts real paper trades and hypothetical evals separately", async () => {
    const key = `LONG_BREAKOUT:agg${++seq}`;
    await prisma.setupType.create({ data: { key, kind: "LONG_BREAKOUT", paramsHash: `agg${seq}`, expectancy: 2 } });
    const base = { typeKey: key };
    // 2 real paper trades: +4 and -2
    const a = await mkSetup({ ...base, state: "PAPER_CLOSED", outcome: "TP2_HIT", outcomePnlPct: 4 });
    await mkClosedTrade({ id: a.setup.id, userId: a.user.id, symbol: a.setup.symbol, typeKey: key }, 4, new Date(Date.now() - 2 * DAY));
    const b = await mkSetup({ ...base, state: "PAPER_CLOSED", outcome: "SL_HIT", outcomePnlPct: -2 });
    await mkClosedTrade({ id: b.setup.id, userId: b.user.id, symbol: b.setup.symbol, typeKey: key }, -2, new Date(Date.now() - DAY));
    // 1 hypothetical triggered loss, 1 hypothetical never-triggered
    await mkSetup({ ...base, state: "EXPIRED", outcome: "SL_HIT", outcomePnlPct: -4, meta: JSON.stringify({ hypothetical: true, triggered: true }) });
    await mkSetup({ ...base, state: "EXPIRED", outcome: "EXPIRED", outcomePnlPct: 0, meta: JSON.stringify({ hypothetical: true, triggered: false }) });

    const stats = (await aggregateSetupType(key))!;
    expect(stats.paperTrades).toBe(2);
    expect(stats.paperExpectancy).toBeCloseTo(1, 6);        // mean(4, -2)
    expect(stats.paperDays).toBe(2);                         // oldest trade 2d ago
    expect(stats.evaluated).toBe(4);
    expect(stats.taken).toBe(3);                             // 2 paper + 1 triggered hypo
    expect(stats.liveAccuracy).toBeCloseTo((1 / 3) * 100, 6);// wins: only +4
    expect(stats.liveExpectancy).toBeCloseTo(-0.5, 6);       // mean(4,-2,-4,0)

    const type = await prisma.setupType.findUnique({ where: { key } });
    expect(type?.paperTrades).toBe(2);
    expect(type?.paperExpectancy).toBeCloseTo(1, 6);
    expect(type?.paperDays).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("shouldDegrade — boundaries", () => {
  const base = { paperTrades: 0, paperDays: 0, paperExpectancy: 1, expectancy: 4 };

  it("trade-count gate: 19 no, 20 yes", () => {
    expect(shouldDegrade({ ...base, paperTrades: DEGRADE_MIN_PAPER_TRADES - 1 })).toBe(false);
    expect(shouldDegrade({ ...base, paperTrades: DEGRADE_MIN_PAPER_TRADES })).toBe(true);
  });

  it("days gate: 6 no, 7 yes", () => {
    expect(shouldDegrade({ ...base, paperDays: DEGRADE_MIN_PAPER_DAYS - 1 })).toBe(false);
    expect(shouldDegrade({ ...base, paperDays: DEGRADE_MIN_PAPER_DAYS })).toBe(true);
  });

  it("either gate suffices; neither → no", () => {
    expect(shouldDegrade({ ...base, paperTrades: 25 })).toBe(true);
    expect(shouldDegrade({ ...base, paperDays: 10 })).toBe(true);
    expect(shouldDegrade({ ...base, paperTrades: 19, paperDays: 6 })).toBe(false);
  });

  it("significantly-worse boundary at half the backtest expectancy", () => {
    const ok = { paperTrades: 30, paperDays: 10, expectancy: 4 };
    expect(shouldDegrade({ ...ok, paperExpectancy: 2 })).toBe(false);   // == 50% — not worse enough
    expect(shouldDegrade({ ...ok, paperExpectancy: 1.99 })).toBe(true);
    expect(shouldDegrade({ ...ok, paperExpectancy: 3 })).toBe(false);
    expect(shouldDegrade({ ...ok, paperExpectancy: null })).toBe(false);
  });
});

describe("runStatsAggregator — degradation", () => {
  it("degrades a pattern after ≥20 bad paper trades: flag + reason + halved weight + journal", async () => {
    const key = `LONG_BOUNCE:deg${++seq}`;
    await prisma.setupType.create({ data: { key, kind: "LONG_BOUNCE", paramsHash: `deg${seq}`, expectancy: 4, weight: 1 } });
    for (let i = 0; i < 20; i++) {
      const s = await mkSetup({ typeKey: key });
      await mkClosedTrade({ id: s.setup.id, userId: s.user.id, symbol: s.setup.symbol, typeKey: key }, 1, new Date(Date.now() - DAY));
    }
    const r = await runStatsAggregator();
    expect(r.degraded).toContain(key);
    const type = await prisma.setupType.findUnique({ where: { key } });
    expect(type?.degraded).toBe(true);
    expect(type?.degradedReason).toContain("پیپر");
    expect(type?.weight).toBeCloseTo(DEGRADED_WEIGHT, 6);
    const j = await prisma.agentJournal.findFirst({ where: { type: "DEGRADED", data: { contains: key } } });
    expect(j?.reason).toBeTruthy();

    // idempotent — a second run doesn't double-cut the weight or re-journal
    await runStatsAggregator();
    const again = await prisma.setupType.findUnique({ where: { key } });
    expect(again?.weight).toBeCloseTo(DEGRADED_WEIGHT, 6);
    expect(await prisma.agentJournal.count({ where: { type: "DEGRADED", data: { contains: key } } })).toBe(1);
  });

  it("degrades via the ≥7-day gate with few trades", async () => {
    const key = `SHORT_BREAKDOWN:deg${++seq}`;
    await prisma.setupType.create({ data: { key, kind: "SHORT_BREAKDOWN", paramsHash: `deg${seq}`, expectancy: 4 } });
    const s = await mkSetup({ typeKey: key, kind: "SHORT_BREAKDOWN", direction: "SHORT" });
    await mkClosedTrade({ id: s.setup.id, userId: s.user.id, symbol: s.setup.symbol, typeKey: key }, -3, new Date(Date.now() - 8 * DAY));
    await runStatsAggregator();
    const type = await prisma.setupType.findUnique({ where: { key } });
    expect(type?.paperDays).toBe(8);
    expect(type?.degraded).toBe(true);
  });

  it("does not degrade when paper matches or beats the backtest", async () => {
    const key = `LONG_BREAKOUT:ok${++seq}`;
    await prisma.setupType.create({ data: { key, kind: "LONG_BREAKOUT", paramsHash: `ok${seq}`, expectancy: 2 } });
    const s = await mkSetup({ typeKey: key });
    await mkClosedTrade({ id: s.setup.id, userId: s.user.id, symbol: s.setup.symbol, typeKey: key }, 3, new Date(Date.now() - 8 * DAY));
    await runStatsAggregator();
    const type = await prisma.setupType.findUnique({ where: { key } });
    expect(type?.degraded).toBe(false);
    expect(type?.weight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ranking weight — degraded types sink in setup ranking
// ---------------------------------------------------------------------------

describe("degraded weight in ranking", () => {
  it("halves the persisted score via persistSetups", async () => {
    const { persistSetups } = await import("@/modules/signal-factory/setups");
    const user = await prisma.user.create({ data: { username: `rk${++seq}`, passwordHash: "x", referralCode: `RK${seq}` } });
    const cfg = await getOrCreateConfig(user.id);
    const draft: SetupDraft = {
      symbol: "RK-USDT", direction: "LONG", kind: "LONG_BREAKOUT", timeframe: "4h",
      triggerPrice: 2100, confirmRule: "CLOSE_ABOVE_TF", entryLow: 2100, entryHigh: 2130,
      tp1: 2250, tp2: 2350, sl: 2050, invalidatePrice: 1980, rr: 2,
      score: 80, confidence: 0.7, reasonFa: "تست",
      levelsMeta: { trigger: "سوینگ 4h", entry: "سوینگ 4h ±ATR", sl: "ATR×1.2", tp1: "کلاستر", tp2: "سوینگ", invalidate: "سوینگ" },
      expiresAt: new Date(Date.now() + 36 * 3_600_000), priceAtScan: 2050, executable: true,
    };
    const { typeKey, paramsHash } = typeKeyOf(draft, "NEUTRAL");
    await prisma.setupType.create({ data: { key: typeKey, kind: "LONG_BREAKOUT", paramsHash, degraded: true, weight: 0.5 } });
    await persistSetups(cfg, [draft], "NEUTRAL");
    const row = await prisma.setup.findFirst({ where: { configId: cfg.id } });
    expect(row?.score).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping — setups >30d deleted, PaperTrade survives with NULL setupId
// ---------------------------------------------------------------------------

describe("housekeeping", () => {
  it("deleting old setups keeps the PaperTrade row and nulls the FK", async () => {
    const old = new Date(Date.now() - 31 * DAY);
    const { setup } = await mkSetup({ createdAt: old, expiresAt: new Date(old.getTime() + 2 * DAY) });
    await mkClosedTrade({ id: setup.id, userId: setup.userId, symbol: setup.symbol, typeKey: setup.typeKey }, 2, old);
    await prisma.setup.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * DAY) } } });
    expect(await prisma.setup.count()).toBe(0);
    const pt = await prisma.paperTrade.findMany();
    expect(pt).toHaveLength(1);
    expect(pt[0].setupId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// daily-report
// ---------------------------------------------------------------------------

describe("runDailyReport", () => {
  it("writes a Persian DAILY_REPORT journal entry per configured user", async () => {
    const { setup, user } = await mkSetup({ state: "PAPER_CLOSED", outcome: "TP2_HIT", outcomePnlPct: 4 });
    await mkClosedTrade({ id: setup.id, userId: user.id, symbol: setup.symbol, typeKey: setup.typeKey }, 4, new Date());
    const n = await runDailyReport();
    expect(n).toBeGreaterThanOrEqual(1); // one entry per configured user
    const j = await prisma.agentJournal.findFirst({ where: { type: "DAILY_REPORT" } });
    expect(j?.summary).toContain("گزارش روزانه‌ی سیگنال‌ساز");
    expect(j?.summary).toContain("درس روز:");
  });
});
