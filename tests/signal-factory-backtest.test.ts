import { TEST_DB } from "./sf-backtest-env";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "@/modules/exchanges/types";
import type { SimTrade } from "@/modules/backtest/engine";
import {
  replaySetupRule, judgeVerdict, backtestSetup, COMBINED_SYMBOL,
  type SetupRule,
} from "@/modules/signal-factory/backtest";

/**
 * Stage-3 tests — rule replay on synthetic candle series with known outcomes,
 * honest verdict labels, and DB plumbing (SetupBacktest rows + SetupType
 * rollup + BACKTEST journal).
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

// ---------------------------------------------------------------------------

const STEP = 14_400_000; // 4h
const T0 = Date.now() - 600 * STEP;
const OPTS = { feePct: 0.25, slippagePct: 0.05, initialBalance: 10_000 };
const SLIP = 1 + OPTS.slippagePct / 100;

/** LONG_BREAKOUT-shaped rule: close > 100 confirms, enter next open. */
const RULE: SetupRule = {
  direction: "LONG",
  confirmRule: "CLOSE_ABOVE_TF",
  triggerPrice: 100,
  entryLow: 100, entryHigh: 101,
  tp1: 104, tp2: 108, sl: 96,
  horizonCandles: 6,
};

const mk = (o: number, h: number, l: number, c: number, i: number): Candle =>
  ({ time: T0 + i * STEP, open: o, high: h, low: l, close: c, volume: 100 });

/** one winning occurrence: confirm → entry candle touches TP1 → next hits TP2 → reset under the trigger */
function winCycle(i: number): Candle[] {
  return [
    mk(99, 99.6, 98.8, 99, i),
    mk(99, 99.6, 98.8, 99, i + 1),
    mk(99.5, 100.8, 99, 101, i + 2),    // close > 100 → confirm edge
    mk(101, 105, 100.5, 104.5, i + 3),  // entry open 101, TP1 touched
    mk(104.5, 108.5, 104, 108, i + 4),  // TP2 touched
    mk(108, 108, 97, 98, i + 5),        // close back under trigger → re-arm
  ];
}

/** one losing occurrence: confirm → entry candle slides straight into SL */
function loseCycle(i: number): Candle[] {
  return [
    mk(99, 99.6, 98.8, 99, i),
    mk(99.5, 100.8, 99, 101, i + 1),
    mk(101, 101.5, 95, 96.5, i + 2),    // entry open 101, SL touched
    mk(96.5, 98, 95.5, 97.5, i + 3),
    mk(97.5, 99, 96.5, 98, i + 4),      // close under trigger → re-arm
  ];
}

const series = (cycle: (i: number) => Candle[], n: number) =>
  Array.from({ length: n }, (_, k) => cycle(k * 10)).flat()
    .concat([mk(98, 98.5, 97.5, 98, 900), mk(98, 98.5, 97.5, 98, 901)]);

const fabricated = (pnlPct: number, i: number): SimTrade => ({
  side: "BUY", entryPrice: 1, exitPrice: 1, amount: 1, fee: 0.01,
  pnl: pnlPct * 10, pnlPct,
  entryTime: T0 + i * 60_000, exitTime: T0 + i * 60_000 + 60_000,
  exitReason: pnlPct > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
});

// ---------------------------------------------------------------------------

describe("replaySetupRule — strict causality + exits", () => {
  it("always-win series: every occurrence banks TP1 then exits at TP2", () => {
    const { trades } = replaySetupRule(RULE, series(winCycle, 3), OPTS);
    expect(trades).toHaveLength(6); // 2 legs per occurrence
    expect(trades.map((t) => t.exitReason)).toEqual(
      Array(3).fill(["PARTIAL_TP", "TP2_HIT"]).flat(),
    );
    for (const t of trades) expect(t.pnl).toBeGreaterThan(0);
  });

  it("enters on the NEXT candle open (never the confirm candle)", () => {
    const candles = series(winCycle, 1);
    const { trades } = replaySetupRule(RULE, candles, OPTS);
    const confirmIdx = candles.findIndex((c) => c.close > RULE.triggerPrice);
    const entryCandle = candles[confirmIdx + 1];
    expect(entryCandle.open).toBe(101);
    for (const t of trades) {
      expect(t.entryPrice).toBeCloseTo(entryCandle.open * SLIP, 6);
      expect(t.entryTime).toBe(entryCandle.time);
    }
  });

  it("always-lose series: SL_HIT on every occurrence, all negative", () => {
    const { trades } = replaySetupRule(RULE, series(loseCycle, 4), OPTS);
    expect(trades).toHaveLength(4);
    for (const t of trades) {
      expect(t.exitReason).toBe("SL_HIT");
      expect(t.pnl).toBeLessThan(0);
    }
  });

  it("a candle touching TP1 and SL resolves to SL (conservative, no partial)", () => {
    const candles = [
      mk(99, 99.6, 98.8, 99, 0),
      mk(99.5, 100.8, 99, 101, 1),          // confirm
      mk(101, 106, 94, 99, 2),              // entry candle: high>TP1 AND low<SL
      mk(99, 99.5, 98, 99, 3),
    ];
    const { trades } = replaySetupRule(RULE, candles, OPTS);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("SL_HIT");
    expect(trades[0].pnl).toBeLessThan(0);
  });

  it("exits at close with EXPIRED once the horizon elapses", () => {
    const candles = [
      mk(99, 99.6, 98.8, 99, 0),
      mk(99.5, 100.8, 99, 101, 1),          // confirm
      // 6 in-range candles — never touch TP1/SL
      ...Array.from({ length: 6 }, (_, k) => mk(101, 102, 100.5, 101.5, 2 + k)),
    ];
    const { trades } = replaySetupRule(RULE, candles, OPTS);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe("EXPIRED");
    expect(trades[0].exitTime).toBe(candles.at(-1)!.time);
  });
});

describe("verdict labels", () => {
  it("labels INSUFFICIENT under 30 pooled trades", () => {
    const v = judgeVerdict(Array.from({ length: 12 }, (_, i) => fabricated(2, i)));
    expect(v.label).toBe("INSUFFICIENT");
    expect(v.totalTrades).toBe(12);
  });

  it("labels VERIFIED on ≥30 trades passing the acceptance gate", () => {
    // 30 wins +2%, 10 losses −1% interleaved → high PF, positive expectancy,
    // tiny drawdown, train/test evenly mixed
    const trades = Array.from({ length: 40 }, (_, i) => fabricated(i % 4 === 3 ? -1 : 2, i));
    const v = judgeVerdict(trades);
    expect(v.label).toBe("VERIFIED");
    expect(v.test.profitFactor).toBeGreaterThan(1.3);
    expect(v.test.expectancy).toBeGreaterThan(0);
  });

  it("labels REJECTED with Persian reasons on a losing pattern", () => {
    const trades = Array.from({ length: 40 }, (_, i) => fabricated(i % 4 === 3 ? 2 : -1, i));
    const v = judgeVerdict(trades);
    expect(v.label).toBe("REJECTED");
    expect(v.reasons.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

async function mkSetup(userId: string, configId: string, symbol: string) {
  return prisma.setup.create({
    data: {
      userId, configId, exchange: "KUCOIN", symbol, marketType: "SPOT",
      direction: "LONG", kind: "LONG_BREAKOUT", typeKey: `LONG_BREAKOUT:t${symbol}`,
      timeframe: "4h",
      triggerPrice: RULE.triggerPrice, confirmRule: RULE.confirmRule,
      entryLow: RULE.entryLow, entryHigh: RULE.entryHigh,
      tp1: RULE.tp1, tp2: RULE.tp2, sl: RULE.sl,
      invalidatePrice: 95, rr: 2, score: 70, confidence: 0.7,
      reasonFa: "تست", levelsMeta: "{}",
      expiresAt: new Date(Date.now() + RULE.horizonCandles * STEP),
      priceAtScan: 99,
    },
  });
}

describe("backtestSetup plumbing (synthetic candles via injected deps)", () => {
  it("VERIFIED: rows per symbol + COMBINED, SetupType rolled, journal written", async () => {
    const user = await prisma.user.create({ data: { username: "btwin", passwordHash: "x", referralCode: "BT1" } });
    const cfg = await getOrCreateConfig(user.id);
    const setup = await mkSetup(user.id, cfg.id, "WIN-USDT");
    const candles = series(winCycle, 7); // 14 trades per symbol → 42 pooled

    const v = await backtestSetup(setup, {
      peers: ["P1-USDT", "P2-USDT"],
      fetchCandles: async () => candles,
    });
    expect(v?.label).toBe("VERIFIED");
    expect(v?.totalTrades).toBe(42);

    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.backtestLabel).toBe("VERIFIED");
    expect(row?.state).toBe("BACKTESTED");

    const bts = await prisma.setupBacktest.findMany({ where: { setupId: setup.id } });
    expect(bts).toHaveLength(4); // 3 symbols + pooled
    const combined = bts.find((b) => b.symbol === COMBINED_SYMBOL)!;
    expect(combined.passed).toBe(true);
    expect(combined.feePct).toBeCloseTo(0.25);
    expect(JSON.parse(combined.testMetrics).totalTrades).toBeGreaterThan(0);
    for (const s of ["WIN-USDT", "P1-USDT", "P2-USDT"]) {
      expect(bts.some((b) => b.symbol === s)).toBe(true);
    }

    const type = await prisma.setupType.findUnique({ where: { key: setup.typeKey } });
    expect(type?.samples).toBe(42);
    expect(type?.wins).toBe(42);
    expect(type?.expectancy).toBeGreaterThan(0);

    const journal = await prisma.agentJournal.findFirst({ where: { type: "BACKTEST" } });
    expect(journal?.summary).toContain("تأییدشده");
  });

  it("REJECTED: losing pattern marks setup REJECTED with reasons", async () => {
    const user = await prisma.user.create({ data: { username: "btlose", passwordHash: "x", referralCode: "BT2" } });
    const cfg = await getOrCreateConfig(user.id);
    const setup = await mkSetup(user.id, cfg.id, "LOSE-USDT");
    const candles = series(loseCycle, 11); // 11 trades per symbol → 33 pooled

    const v = await backtestSetup(setup, {
      peers: ["P3-USDT", "P4-USDT"],
      fetchCandles: async () => candles,
    });
    expect(v?.label).toBe("REJECTED");
    expect(v!.reasons.length).toBeGreaterThan(0);

    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.backtestLabel).toBe("REJECTED");
    expect(row?.state).toBe("REJECTED");

    const combined = await prisma.setupBacktest.findFirst({
      where: { setupId: setup.id, symbol: COMBINED_SYMBOL },
    });
    expect(combined?.passed).toBe(false);
    expect(JSON.parse(combined!.reasons).length).toBeGreaterThan(0);
  });

  it("INSUFFICIENT: short history keeps the setup pending", async () => {
    const user = await prisma.user.create({ data: { username: "btins", passwordHash: "x", referralCode: "BT3" } });
    const cfg = await getOrCreateConfig(user.id);
    const setup = await mkSetup(user.id, cfg.id, "THIN-USDT");
    // 1 occurrence per symbol + flat tail (>=40 candles) → 6 pooled trades
    const candles = series(winCycle, 1).concat(
      Array.from({ length: 34 }, (_, k) => mk(98, 98.5, 97.5, 98, 910 + k)),
    );

    const v = await backtestSetup(setup, {
      peers: ["P5-USDT", "P6-USDT"],
      fetchCandles: async () => candles,
    });
    expect(v?.label).toBe("INSUFFICIENT");
    const row = await prisma.setup.findUnique({ where: { id: setup.id } });
    expect(row?.backtestLabel).toBe("INSUFFICIENT");
    expect(row?.state).toBe("PROPOSED");
  });
});
