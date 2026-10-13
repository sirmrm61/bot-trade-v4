import { TEST_DB } from "./sf-live-env";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle, ExchangeAdapter, ExchangeOrder, OrderParams, Ticker } from "@/modules/exchanges/types";
import {
  liveChecklist, approveLive, liveEntry, runLiveManager, killSignalFactory,
  LIVE_SMALL_SCALE, LIVE_MIN_PAPER_TRADES, LIVE_MIN_PAPER_DAYS, LIVE_STAKE_QUOTE,
} from "@/modules/signal-factory/live";
import { runTriggerMonitor } from "@/modules/signal-factory/lifecycle";

/**
 * Stage-6 tests — the promotion checklist (each condition blocking on its
 * own), live entries through the guardrail path, monitored exits, the kill
 * switch on a mocked adapter, and the hard guarantee that no live path ever
 * executes while liveTradingEnabled is false.
 */

let prisma: Awaited<typeof import("@/infrastructure/database/prisma")>["prisma"];
let getOrCreateConfig: Awaited<typeof import("@/modules/signal-factory/config")>["getOrCreateConfig"];
let updateConfig: Awaited<typeof import("@/modules/signal-factory/config")>["updateConfig"];

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
  ({ getOrCreateConfig, updateConfig } = await import("@/modules/signal-factory/config"));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

beforeEach(async () => {
  await prisma.trade.deleteMany();
  await prisma.paperTrade.deleteMany();
  await prisma.setup.deleteMany();
  await prisma.setupBacktest.deleteMany();
  await prisma.setupType.deleteMany();
  await prisma.incident.deleteMany();
});

let seq = 0;
const STEP = 14_400_000; // 4h

async function mkUser() {
  const user = await prisma.user.create({
    data: { username: `lv${++seq}`, passwordHash: "x", referralCode: `LV${seq}` },
  });
  const cfg = await getOrCreateConfig(user.id);
  return { user, cfg };
}

async function mkSetup(userId: string, configId: string, typeKey: string, over: Record<string, unknown> = {}) {
  return prisma.setup.create({
    data: {
      userId, configId, exchange: "KUCOIN",
      symbol: `S${seq}-USDT`, marketType: "SPOT",
      direction: "LONG", kind: "LONG_BREAKOUT", typeKey,
      timeframe: "4h",
      triggerPrice: 100, confirmRule: "CLOSE_ABOVE_TF",
      entryLow: 100, entryHigh: 101, tp1: 106, tp2: 112, sl: 97,
      invalidatePrice: 95, rr: 2, score: 70, confidence: 0.7,
      reasonFa: "تست", levelsMeta: "{}", expiresAt: new Date(Date.now() + 24 * 3_600_000),
      priceAtScan: 99, state: "WAITING_TRIGGER", backtestLabel: "VERIFIED",
      ...over,
    },
  });
}

async function mkType(typeKey: string, over: Record<string, unknown> = {}) {
  return prisma.setupType.create({
    data: {
      key: typeKey, kind: "LONG_BREAKOUT", paramsHash: typeKey.split(":")[1] ?? "",
      samples: 30, wins: 18, expectancy: 1.2,
      paperTrades: LIVE_MIN_PAPER_TRADES, paperDays: LIVE_MIN_PAPER_DAYS, paperExpectancy: 0.8,
      ...over,
    },
  });
}

async function mkBacktestPassed(typeKey: string) {
  return prisma.setupBacktest.create({
    data: {
      typeKey, symbol: "COMBINED", timeframe: "4h",
      startDate: new Date(Date.now() - 90 * 86_400_000), endDate: new Date(),
      feePct: 0.25, slippagePct: 0.05,
      trainMetrics: "{}", testMetrics: "{}", passed: true, reasons: "[]",
    },
  });
}

/** a fully eligible promotion candidate */
async function mkEligible(over: Record<string, unknown> = {}) {
  const { user, cfg } = await mkUser();
  await updateConfig(user.id, { liveTradingEnabled: true });
  const typeKey = `LONG_BREAKOUT:t${seq}`;
  const type = await mkType(typeKey, over);
  await mkBacktestPassed(typeKey);
  return { user, cfg, typeKey, type };
}

function mockAdapter(opts: { last?: number; openOrders?: ExchangeOrder[] } = {}) {
  const state = { last: opts.last ?? 100 };
  const calls = { createOrder: [] as OrderParams[], canceled: [] as string[] };
  let orderSeq = 0;
  const adapter: ExchangeAdapter = {
    name: "MOCK",
    getMarkets: async () => [],
    getMarketInfo: async () => { throw new Error("n/a"); },
    getBalance: async () => [],
    getTicker: async (symbol) => ({ symbol, last: state.last, ts: Date.now() }),
    getOrderBook: async () => ({ bids: [], asks: [], ts: 0 }),
    getCandles: async () => [],
    createOrder: async (p) => {
      calls.createOrder.push(p);
      return {
        id: `ord-${++orderSeq}`, symbol: p.symbol, side: p.side, type: p.type,
        amount: p.amount, price: p.price, filledAmount: p.amount,
        avgPrice: state.last, status: "filled", createdAt: Date.now(),
      };
    },
    cancelOrder: async (id) => { calls.canceled.push(id); return true; },
    getOrder: async () => { throw new Error("n/a"); },
    getOpenOrders: async () => opts.openOrders ?? [],
    getTradeHistory: async () => [],
    validateCredentials: async () => true,
  };
  return { adapter, calls, state };
}

const mk = (o: number, h: number, l: number, c: number, time: number): Candle =>
  ({ time, open: o, high: h, low: l, close: c, volume: 100 });
const tick = (symbol: string, last: number): Ticker => ({ symbol, last, ts: Date.now() });

// ---------------------------------------------------------------------------

describe("liveChecklist — every condition blocks on its own", () => {
  it("passes only when ALL conditions hold", async () => {
    const { user, typeKey } = await mkEligible();
    const cl = await liveChecklist(typeKey, user.id);
    expect(cl.ok).toBe(true);
    expect(cl.missing).toEqual([]);
  });

  it("fails without a VERIFIED pooled backtest", async () => {
    const { user, typeKey } = await mkEligible();
    await prisma.setupBacktest.deleteMany();
    const cl = await liveChecklist(typeKey, user.id);
    expect(cl.ok).toBe(false);
    expect(cl.missing.some((m) => m.includes("بک‌تست"))).toBe(true);
  });

  it(`fails with fewer than ${LIVE_MIN_PAPER_TRADES} paper trades`, async () => {
    const { user, typeKey } = await mkEligible({ paperTrades: LIVE_MIN_PAPER_TRADES - 1 });
    const cl = await liveChecklist(typeKey, user.id);
    expect(cl.ok).toBe(false);
    expect(cl.missing.some((m) => m.includes("پیپر"))).toBe(true);
  });

  it(`fails with fewer than ${LIVE_MIN_PAPER_DAYS} paper days`, async () => {
    const { user, typeKey } = await mkEligible({ paperDays: LIVE_MIN_PAPER_DAYS - 1 });
    const cl = await liveChecklist(typeKey, user.id);
    expect(cl.ok).toBe(false);
  });

  it("fails on non-positive paper expectancy", async () => {
    for (const paperExpectancy of [0, -0.4, null] as const) {
      const { user, typeKey } = await mkEligible({ paperExpectancy });
      const cl = await liveChecklist(typeKey, user.id);
      expect(cl.ok).toBe(false);
      expect(cl.missing.some((m) => m.includes("امیدوانی"))).toBe(true);
    }
  });

  it("fails when liveTradingEnabled is off", async () => {
    const { user, typeKey, type } = await mkEligible();
    await updateConfig(user.id, { liveTradingEnabled: false });
    const cl = await liveChecklist(typeKey, user.id);
    expect(cl.ok).toBe(false);
    expect(cl.missing.some((m) => m.includes("معاملات واقعی"))).toBe(true);
    await prisma.setupType.delete({ where: { id: type.id } });
    const cl2 = await liveChecklist(`LONG_BREAKOUT:ghost${seq}`, user.id);
    expect(cl2.ok).toBe(false);
  });
});

describe("approveLive — explicit promotion", () => {
  it("approves a fully eligible type → liveApproved + 25% scale + PROMOTION_REQUEST journal", async () => {
    const { user, typeKey } = await mkEligible();
    const t = await approveLive(typeKey, user.id);
    expect(t.liveApproved).toBe(true);
    expect(t.liveSizeScale).toBe(LIVE_SMALL_SCALE);
    expect(t.liveApprovedAt).not.toBeNull();
    const j = await prisma.agentJournal.findFirst({
      where: { type: "PROMOTION_REQUEST", data: { contains: typeKey } },
    });
    expect(j).not.toBeNull();
    // idempotent
    expect((await approveLive(typeKey, user.id)).liveApproved).toBe(true);
  });

  it("rejects an incomplete checklist — no partial credit", async () => {
    const { user, typeKey } = await mkEligible({ paperTrades: 5 });
    await expect(approveLive(typeKey, user.id)).rejects.toMatchObject({ status: 412 });
    const t = await prisma.setupType.findUnique({ where: { key: typeKey } });
    expect(t?.liveApproved).toBe(false);
  });
});

describe("liveEntry — real orders through the guardrail path", () => {
  it("opens a 25%-sized real order → Trade row + setup LIVE_SMALL", async () => {
    const { user, cfg, typeKey } = await mkEligible();
    await approveLive(typeKey, user.id);
    const setup = await mkSetup(user.id, cfg.id, typeKey);
    const { adapter, calls } = mockAdapter({ last: 100 });

    const r = await liveEntry(setup, { adapter });
    expect(r).toBe("OPENED");
    expect(calls.createOrder).toHaveLength(1);
    const o = calls.createOrder[0];
    expect(o.side).toBe("buy");
    expect(o.type).toBe("market");
    expect(o.amount).toBeCloseTo((LIVE_STAKE_QUOTE * LIVE_SMALL_SCALE) / 100, 6);

    const trade = await prisma.trade.findFirst({
      where: { userId: user.id, meta: { contains: '"signalFactory":true' } },
    });
    expect(trade?.status).toBe("OPEN");
    expect(trade?.side).toBe("LONG");
    expect(trade?.stopLossPrice).toBe(97);
    expect(trade?.invested).toBeCloseTo(LIVE_STAKE_QUOTE * LIVE_SMALL_SCALE, 6);
    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.state).toBe("LIVE_SMALL");
    const j = await prisma.agentJournal.findFirst({ where: { type: "TRADE_OPEN" } });
    expect(j).not.toBeNull();

    // idempotent — a second entry attempt never places another order
    expect(await liveEntry(setup, { adapter })).toBe("SKIPPED");
    expect(calls.createOrder).toHaveLength(1);
  });

  it("no live path executes when liveTradingEnabled=false — no order, no trade", async () => {
    const { user, cfg, typeKey } = await mkEligible();
    await prisma.setupType.update({ where: { key: typeKey }, data: { liveApproved: true } });
    await updateConfig(user.id, { liveTradingEnabled: false });
    const setup = await mkSetup(user.id, cfg.id, typeKey);
    const { adapter, calls } = mockAdapter();

    expect(await liveEntry(setup, { adapter })).toBe("SKIPPED");
    expect(calls.createOrder).toHaveLength(0);
    expect(await prisma.trade.count({ where: { userId: user.id } })).toBe(0);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.state).toBe("WAITING_TRIGGER");
  });

  it("unapproved pattern → SKIPPED, no order", async () => {
    const { user, cfg, typeKey } = await mkEligible();
    const setup = await mkSetup(user.id, cfg.id, typeKey);
    const { adapter, calls } = mockAdapter();
    expect(await liveEntry(setup, { adapter })).toBe("SKIPPED");
    expect(calls.createOrder).toHaveLength(0);
  });

  it("a guardrail veto (low score) blocks the order and journals once", async () => {
    const { user, cfg, typeKey } = await mkEligible();
    await approveLive(typeKey, user.id);
    const setup = await mkSetup(user.id, cfg.id, typeKey, { confidence: 0.2 });
    const { adapter, calls } = mockAdapter();

    expect(await liveEntry(setup, { adapter })).toBe("VETOED");
    expect(calls.createOrder).toHaveLength(0);
    expect(await prisma.trade.count()).toBe(0);
    const incidents = await prisma.agentJournal.count({
      where: { type: "INCIDENT", data: { contains: setup.id } },
    });
    expect(incidents).toBe(1);
    // same veto reason → no journal spam on the next monitor pass
    expect(await liveEntry(setup, { adapter })).toBe("VETOED");
    expect(await prisma.agentJournal.count({
      where: { type: "INCIDENT", data: { contains: setup.id } },
    })).toBe(1);
  });

  it("trigger monitor routes an approved pattern to live instead of paper", async () => {
    const now = Date.now();
    const { user, cfg, typeKey } = await mkEligible();
    await approveLive(typeKey, user.id);
    const setup = await mkSetup(user.id, cfg.id, typeKey);
    const { adapter, calls } = mockAdapter();
    const candles = [
      mk(99, 99.5, 98, 99, now - 2 * STEP),
      mk(99.5, 101.2, 99, 101, now - STEP),
      mk(101, 101.5, 100.5, 101.2, now),
    ];
    const r = await runTriggerMonitor({
      now,
      fetchCandles: async () => candles,
      fetchTicker: async (_e, s) => tick(s, 99),
      openLive: (s) => liveEntry(s, { adapter }),
    });
    expect(r.liveOpened).toBe(1);
    expect(r.opened).toBe(0);
    expect(calls.createOrder).toHaveLength(1);
    expect(await prisma.paperTrade.count()).toBe(0);
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.state).toBe("LIVE_SMALL");
  });
});

describe("runLiveManager — monitored exits (no exchange stop orders)", () => {
  async function openLive() {
    const { user, cfg, typeKey } = await mkEligible();
    await approveLive(typeKey, user.id);
    const setup = await mkSetup(user.id, cfg.id, typeKey);
    const { adapter, calls, state } = mockAdapter({ last: 100 });
    await liveEntry(setup, { adapter });
    const trade = (await prisma.trade.findFirst({ where: { userId: user.id } }))!;
    return { user, cfg, typeKey, setup, adapter, calls, state, trade };
  }

  it("a ticker below SL market-closes the whole position → SL_HIT", async () => {
    const { setup, adapter, calls, state, trade } = await openLive();
    state.last = 96; // < sl 97
    const r = await runLiveManager({
      adapterFor: async () => adapter,
      fetchTicker: async (_e, s) => tick(s, 96),
    });
    expect(r.closed).toBe(1);
    expect(calls.createOrder).toHaveLength(2); // entry + exit
    const exit = calls.createOrder[1];
    expect(exit.side).toBe("sell");
    const row = (await prisma.trade.findUnique({ where: { id: trade.id } }))!;
    expect(row.status).toBe("CLOSED");
    expect(row.exitReason).toBe("STOP_LOSS");
    expect(row.pnl).toBeLessThan(0);
    const s = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(s?.outcome).toBe("SL_HIT");
    expect(s?.closedAt).not.toBeNull();
  });

  it("TP1 banks 50% via a real sell and moves the stop to breakeven", async () => {
    const { adapter, calls, state, trade } = await openLive();
    state.last = 106.5; // > tp1 106
    const r = await runLiveManager({
      adapterFor: async () => adapter,
      fetchTicker: async (_e, s) => tick(s, 106.5), // > tp1 106
    });
    expect(r.closed).toBe(0);
    expect(calls.createOrder).toHaveLength(2);
    expect(calls.createOrder[1].amount).toBeCloseTo(trade.amount / 2, 6);
    const row = (await prisma.trade.findUnique({ where: { id: trade.id } }))!;
    expect(row.status).toBe("OPEN");
    expect(row.amount).toBeCloseTo(trade.amount / 2, 6);
    expect(row.stopLossPrice).toBeCloseTo(trade.entryPrice, 6); // breakeven
  });

  it("TP2 closes fully → TP2_HIT", async () => {
    const { setup, adapter, state, trade } = await openLive();
    state.last = 113; // > tp2 112
    await runLiveManager({
      adapterFor: async () => adapter,
      fetchTicker: async (_e, s) => tick(s, 113), // > tp2 112
    });
    const row = (await prisma.trade.findUnique({ where: { id: trade.id } }))!;
    expect(row.status).toBe("CLOSED");
    expect(row.exitReason).toBe("TAKE_PROFIT");
    expect((await prisma.setup.findUnique({ where: { id: setup.id } }))?.outcome).toBe("TP2_HIT");
  });
});

describe("killSignalFactory — emergency stop", () => {
  it("cancels only our open orders, disables config + live, writes Incident + journal", async () => {
    const { user, cfg, typeKey } = await mkEligible();
    await approveLive(typeKey, user.id);
    const setup = await mkSetup(user.id, cfg.id, typeKey);
    const ourOrder: ExchangeOrder = {
      id: "sf-open-1", symbol: setup.symbol, side: "buy", type: "limit",
      amount: 1, price: 99, filledAmount: 0, status: "open", createdAt: Date.now(),
    };
    const foreignOrder: ExchangeOrder = {
      id: "user-order-9", symbol: "BTC-USDT", side: "sell", type: "limit",
      amount: 1, price: 99, filledAmount: 0, status: "open", createdAt: Date.now(),
    };
    const { adapter, calls } = mockAdapter({ openOrders: [ourOrder, foreignOrder] });
    await liveEntry(setup, { adapter });
    // plant a still-open recorded order id on the trade meta
    const trade = (await prisma.trade.findFirst({ where: { userId: user.id } }))!;
    const meta = JSON.parse(trade.meta!) as { orderIds: string[] };
    meta.orderIds.push("sf-open-1");
    await prisma.trade.update({ where: { id: trade.id }, data: { meta: JSON.stringify(meta) } });

    const r = await killSignalFactory(user.id, { adapter });
    expect(r.adapterOk).toBe(true);
    expect(r.canceled).toEqual(["sf-open-1"]); // foreign order untouched
    expect(calls.canceled).toEqual(["sf-open-1"]);

    const cfg2 = await prisma.signalMakerConfig.findUnique({ where: { userId: user.id } });
    expect(cfg2?.enabled).toBe(false);
    expect(cfg2?.liveTradingEnabled).toBe(false);

    const inc = await prisma.incident.findFirst({ where: { userId: user.id, kind: "KILL_SWITCH" } });
    expect(inc).not.toBeNull();
    expect(inc?.summary).toContain("توقف اضطراری");
    const j = await prisma.agentJournal.findFirst({
      where: { type: "INCIDENT", summary: { contains: "توقف اضطراری" } },
    });
    expect(j).not.toBeNull();
  });
});
