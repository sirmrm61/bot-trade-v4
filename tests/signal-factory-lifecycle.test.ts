import { TEST_DB } from "./sf-lifecycle-env";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle, Ticker } from "@/modules/exchanges/types";
import { lastClosedCandle, isInvalidated, runTriggerMonitor } from "@/modules/signal-factory/lifecycle";
import { openPaperTrade, paperEvents, managePaperTrade, runPaperManager } from "@/modules/signal-factory/paper";

/**
 * Stage-4 tests — the lifecycle state machine (promotion, trigger fire,
 * invalidation, expiry, terminals) and paper trading (open at trigger with
 * real costs, TP1 partial + breakeven runner, TP2/SL/expire closes,
 * SetupType rollup, journal coverage).
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

// the monitors scan every pre-entry setup / open trade — keep tests isolated
beforeEach(async () => {
  await prisma.paperTrade.deleteMany();
  await prisma.setup.deleteMany();
});

// ---------------------------------------------------------------------------

const STEP = 14_400_000; // 4h
const FEE = 0.25, SLIP = 0.05;
let seq = 0;

const mk = (o: number, h: number, l: number, c: number, time: number): Candle =>
  ({ time, open: o, high: h, low: l, close: c, volume: 100 });

const tick = (symbol: string, last: number): Ticker => ({ symbol, last, ts: Date.now() });

async function mkSetup(over: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: { username: `lc${++seq}`, passwordHash: "x", referralCode: `LC${seq}` },
  });
  const cfg = await getOrCreateConfig(user.id);
  const setup = await prisma.setup.create({
    data: {
      userId: user.id, configId: cfg.id, exchange: "KUCOIN",
      symbol: `S${seq}-USDT`, marketType: "SPOT",
      direction: "LONG", kind: "LONG_BREAKOUT", typeKey: `LONG_BREAKOUT:t${seq}`,
      timeframe: "4h",
      triggerPrice: 100, confirmRule: "CLOSE_ABOVE_TF",
      entryLow: 100, entryHigh: 101, tp1: 104, tp2: 108, sl: 96,
      invalidatePrice: 95, rr: 2, score: 70, confidence: 0.7,
      reasonFa: "تست", levelsMeta: "{}", expiresAt: new Date(Date.now() + 24 * 3_600_000),
      priceAtScan: 99,
      ...over,
    },
  });
  return { user, cfg, setup };
}

const monitorDeps = (candles: Candle[], last = 99) => ({
  fetchCandles: async () => candles,
  fetchTicker: async (_e: string, s: string) => tick(s, last),
});

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  const now = Date.now();
  it("lastClosedCandle ignores the forming candle", () => {
    const candles = [mk(1, 1, 1, 1, now - 2 * STEP), mk(2, 2, 2, 2, now - STEP), mk(3, 3, 3, 3, now)];
    expect(lastClosedCandle(candles, "4h", now)?.time).toBe(now - STEP);
  });
  it("isInvalidated is direction-aware", () => {
    expect(isInvalidated({ direction: "LONG", invalidatePrice: 95 } as never, 94)).toBe(true);
    expect(isInvalidated({ direction: "LONG", invalidatePrice: 95 } as never, 96)).toBe(false);
    expect(isInvalidated({ direction: "SHORT", invalidatePrice: 105 } as never, 106)).toBe(true);
    expect(isInvalidated({ direction: "SHORT", invalidatePrice: 105 } as never, 104)).toBe(false);
  });
});

describe("runTriggerMonitor — state machine", () => {
  it("promotes PROPOSED + NOT_TESTED to WAITING_TRIGGER and journals it", async () => {
    const now = Date.now();
    const { setup } = await mkSetup();
    const candles = [mk(99, 99.5, 98, 99, now - STEP), mk(99, 99.2, 98.5, 99, now)];

    const r = await runTriggerMonitor({ ...monitorDeps(candles), now });
    expect(r.promoted).toBe(1);

    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.state).toBe("WAITING_TRIGGER");
    expect(row?.activatedAt).not.toBeNull();

    const j = await prisma.agentJournal.findFirst({
      where: { type: "SETUP_STATE_CHANGE", data: { contains: setup.id } },
    });
    expect(j?.reason).toBeTruthy();
  });

  it("fires the trigger on a confirming CLOSED candle → PAPER_OPEN at the trigger price + costs", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const candles = [
      mk(99, 99.5, 98, 99, now - 2 * STEP),
      mk(99.5, 101.2, 99, 101, now - STEP), // closed, confirms (close > 100)
      mk(101, 101.5, 100.5, 101.2, now),    // forming — must not drive the decision
    ];
    const r = await runTriggerMonitor({ ...monitorDeps(candles), now });
    expect(r.opened).toBe(1);

    const row = await prisma.setup.findUnique({ where: { id: setup.id }, include: { paperTrade: true } });
    expect(row?.state).toBe("PAPER_OPEN");
    expect(row?.paperTrade?.entryPrice).toBeCloseTo(100 * (1 + SLIP / 100), 6);
    expect(row?.paperTrade?.side).toBe("BUY");
    expect(row?.paperTrade?.invested).toBe(1000);
    expect(row?.paperTrade?.costsPct).toBeCloseTo(2 * (FEE + SLIP), 6);

    const j = await prisma.agentJournal.findFirst({
      where: { type: "PAPER_TRADE", data: { contains: setup.id } },
    });
    expect(j?.summary).toContain("باز شد");
  });

  it("a forming candle does NOT fire the trigger", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const candles = [
      mk(99, 99.5, 98, 99, now - STEP),   // closed, no confirm
      mk(99, 101.5, 99, 101, now),        // forming above trigger — ignored
    ];
    const r = await runTriggerMonitor({ ...monitorDeps(candles), now });
    expect(r.opened).toBe(0);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.state).toBe("WAITING_TRIGGER");
  });

  it("SHORT trigger opens a SELL paper trade at trigger − slippage", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({
      state: "WAITING_TRIGGER", direction: "SHORT", kind: "SHORT_BREAKDOWN",
      marketType: "FUTURES", confirmRule: "CLOSE_BELOW_TF",
      triggerPrice: 100, entryLow: 99, entryHigh: 100,
      tp1: 96, tp2: 92, sl: 104, invalidatePrice: 105,
    });
    const candles = [mk(101, 101.5, 98.5, 99, now - STEP), mk(99, 99.4, 98.8, 99.2, now)];
    const r = await runTriggerMonitor({ ...monitorDeps(candles), now });
    expect(r.opened).toBe(1);
    const pt = await prisma.paperTrade.findUnique({ where: { setupId: setup.id } });
    expect(pt?.side).toBe("SELL");
    expect(pt?.entryPrice).toBeCloseTo(100 * (1 - SLIP / 100), 6);
  });

  it("invalidates before entry when the ticker crosses invalidatePrice", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const candles = [mk(99, 99.5, 98, 99, now - STEP)];
    const r = await runTriggerMonitor({ ...monitorDeps(candles, 94), now });
    expect(r.invalidated).toBe(1);
    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.state).toBe("INVALIDATED");
    expect(row?.closedAt).not.toBeNull();
  });

  it("expires a pending setup past expiresAt", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ expiresAt: new Date(now - 60_000) });
    const r = await runTriggerMonitor({ ...monitorDeps([]), now });
    expect(r.expired).toBe(1);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.state).toBe("EXPIRED");
  });

  it("REJECTED label → REJECTED terminal; INSUFFICIENT stays pending", async () => {
    const now = Date.now();
    const a = await mkSetup({ backtestLabel: "REJECTED" });
    const b = await mkSetup({ backtestLabel: "INSUFFICIENT" });
    const candles = [mk(99, 99.5, 98, 99, now - STEP)];
    const r = await runTriggerMonitor({ ...monitorDeps(candles), now });
    expect(r.rejected).toBe(1);
    expect((await prisma.setup.findUnique({ where: { id: a.setup.id } }))?.state).toBe("REJECTED");
    expect((await prisma.setup.findUnique({ where: { id: b.setup.id } }))?.state).toBe("PROPOSED");
  });

  it("terminal setups are never re-evaluated", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ state: "EXPIRED", closedAt: new Date(now - 60_000) });
    const candles = [mk(99.5, 101.5, 99, 101, now - STEP)]; // would confirm if evaluated
    const r = await runTriggerMonitor({ ...monitorDeps(candles), now });
    expect(r.checked).toBe(0);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.state).toBe("EXPIRED");
  });
});

// ---------------------------------------------------------------------------

describe("paper trading", () => {
  it("opens at the real trigger price with fee + slippage deducted", async () => {
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const pt = await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP });
    expect(pt?.entryPrice).toBeCloseTo(100.05, 6);
    expect(pt?.invested).toBe(1000);
    // amount = (invested − entryFee) / fill  (same model as the backtest)
    expect(pt?.amount).toBeCloseTo((1000 - 1000 * FEE / 100) / 100.05, 6);
    // idempotent
    expect((await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))?.id).toBe(pt?.id);
  });

  it("paperEvents — SL wins ambiguity, TP1+TP2 come in order", () => {
    const t = { side: "BUY", tp1: 104, tp2: 108, sl: 96, tp1Hit: false } as never;
    expect(paperEvents(t, mk(100, 105, 99, 104, 0))).toEqual(["TP1"]);
    expect(paperEvents(t, mk(100, 109, 99, 108, 0))).toEqual(["TP1", "TP2"]);
    expect(paperEvents(t, mk(100, 105, 95, 99, 0))).toEqual(["SL"]);
    const done = { side: "BUY", tp1: 104, tp2: 108, sl: 100.05, tp1Hit: true } as never;
    expect(paperEvents(done, mk(102, 109, 101, 108, 0))).toEqual(["TP2"]);
    expect(paperEvents(done, mk(102, 103, 99, 100, 0))).toEqual(["SL"]);
  });

  it("TP1 banks 50% and moves the stop to breakeven; the runner then scratches at BE", async () => {
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const pt = (await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))!;
    const now = Date.now();

    let status = await managePaperTrade(pt, setup, mk(101, 105, 100.5, 104.5, now), now);
    expect(status).toBe("OPEN");
    let row = (await prisma.paperTrade.findUnique({ where: { id: pt.id } }))!;
    expect(row.tp1Hit).toBe(true);
    expect(row.amount).toBeCloseTo(pt.amount / 2, 6);
    expect(row.invested).toBeCloseTo(500, 6);
    expect(row.sl).toBeCloseTo(pt.entryPrice, 6); // breakeven on the runner

    // stop at breakeven fills → CLOSED; the setup's outcome is TP1_HIT
    status = await managePaperTrade(row, setup, mk(101, 101.5, 99.5, 100, now), now);
    expect(status).toBe("CLOSED");
    row = (await prisma.paperTrade.findUnique({ where: { id: pt.id } }))!;
    expect(row.status).toBe("CLOSED");
    expect(row.exitReason).toBe("SL_HIT");
    expect(row.exitPrice).toBeCloseTo(pt.entryPrice * (1 - SLIP / 100), 4);
    expect(row.pnl).toBeGreaterThan(0); // banked TP1 leg outweighs the BE scratch

    const s = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(s?.state).toBe("PAPER_CLOSED");
    expect(s?.outcome).toBe("TP1_HIT");
    expect(s?.outcomePnlPct).toBeCloseTo(row.pnlPct!, 6);

    const type = await prisma.setupType.findUnique({ where: { key: setup.typeKey } });
    expect(type?.paperTrades).toBe(1);
    expect(type?.paperExpectancy).toBeCloseTo(row.pnlPct!, 6);
  });

  it("SL before any target → SL_HIT with a ~full-risk loss", async () => {
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const pt = (await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))!;
    const status = await managePaperTrade(pt, setup, mk(101, 101.2, 95, 96.5, Date.now()));
    expect(status).toBe("CLOSED");
    const row = (await prisma.paperTrade.findUnique({ where: { id: pt.id } }))!;
    expect(row.exitReason).toBe("SL_HIT");
    expect(row.pnlPct).toBeLessThan(-3); // −4% gross minus costs
    const s = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(s?.outcome).toBe("SL_HIT");
    expect(s?.state).toBe("PAPER_CLOSED");
  });

  it("one candle through TP1 and TP2 banks the partial then closes TP2_HIT", async () => {
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const pt = (await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))!;
    const status = await managePaperTrade(pt, setup, mk(101, 109, 100.5, 108.5, Date.now()));
    expect(status).toBe("CLOSED");
    const row = (await prisma.paperTrade.findUnique({ where: { id: pt.id } }))!;
    expect(row.tp1Hit).toBe(true);
    expect(row.exitReason).toBe("TP2_HIT");
    expect(row.pnlPct).toBeGreaterThan(4);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.outcome).toBe("TP2_HIT");
  });

  it("a candle touching SL and TP1 resolves to SL — no partial", async () => {
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const pt = (await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))!;
    const status = await managePaperTrade(pt, setup, mk(101, 105, 94, 99, Date.now()));
    expect(status).toBe("CLOSED");
    const row = (await prisma.paperTrade.findUnique({ where: { id: pt.id } }))!;
    expect(row.tp1Hit).toBe(false);
    expect(row.exitReason).toBe("SL_HIT");
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.outcome).toBe("SL_HIT");
  });

  it("expiry closes the trade at the candle close → outcome EXPIRED", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER", expiresAt: new Date(now - 60_000) });
    const pt = (await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))!;
    const status = await managePaperTrade(pt, setup, mk(101, 102, 100, 101.5, now), now);
    expect(status).toBe("CLOSED");
    const row = (await prisma.paperTrade.findUnique({ where: { id: pt.id } }))!;
    expect(row.exitReason).toBe("EXPIRED");
    expect(row.exitPrice).toBeCloseTo(101.5 * (1 - SLIP / 100), 4);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.outcome).toBe("EXPIRED");
  });

  it("runPaperManager manages open trades off injected candles", async () => {
    const now = Date.now();
    const { setup } = await mkSetup({ state: "WAITING_TRIGGER" });
    const pt = (await openPaperTrade(setup, { feePct: FEE, slippagePct: SLIP }))!;
    const r = await runPaperManager({
      now,
      fetchCandles: async () => [mk(101, 104.5, 100.5, 104, now)], // touches TP1
    });
    expect(r.managed).toBe(1);
    const row = await prisma.paperTrade.findUnique({ where: { id: pt.id } });
    expect(row?.tp1Hit).toBe(true);
    expect(row?.status).toBe("OPEN");
  });
});
