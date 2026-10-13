import { TEST_DB } from "./sf-setups-env";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "@/modules/exchanges/types";
import { extractLevels, levelsAbove, levelsBelow } from "@/modules/signal-factory/levels";
import {
  analyzePair, buildSetups, persistSetups, rankTop, MIN_RR,
  type PairAnalysis, type SetupDraft,
} from "@/modules/signal-factory/setups";
import { trendOf, volatilityOf, regimeOf } from "@/modules/signal-factory/context";

/**
 * Stage-2 tests — pure level/setup logic on synthetic candles + DB dedupe
 * against a throwaway SQLite with all migrations applied.
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

const TF4H = 14_400_000;

function mkCandles(closes: number[], step = TF4H): Candle[] {
  const t0 = Date.now() - closes.length * step;
  // open = close → highs/lows track the close exactly, so path junctions are
  // the only swing points and never tie with a neighbour
  return closes.map((c, i) => ({
    time: t0 + i * step,
    open: c,
    high: c * 1.006,
    low: c * 0.994,
    close: c,
    volume: 100 + (i % 7) * 20,
  }));
}

const seg = (a: number, b: number, n: number) =>
  Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

/** concatenate segments dropping the duplicated boundary point */
const join = (...segs: number[][]) => segs.flatMap((s, i) => (i ? s.slice(1) : s));

/** rally to a peak, pullback, recovery ending just under the peak → resistance overhead */
function resistancePath(): number[] {
  return join(
    seg(90, 95, 30),
    seg(95, 100, 15),           // swing high ~100
    seg(100, 95.5, 30),
    seg(95.5, 98.4, 45),        // end ~1.6 under the level
  );
}

/** decline into a floor, base twice, end just above it → support below */
function supportPath(): number[] {
  return join(
    seg(105, 98, 35),
    seg(98, 96, 10),            // first dip
    seg(96, 99, 15),            // pop
    seg(99, 96.1, 25),          // second dip → clustered floor ~96
    seg(96.1, 96.9, 35),        // end ~1.1 ATR above the floor
  );
}

const baseAnalysis = (over: Partial<PairAnalysis>): PairAnalysis => ({
  symbol: "TST-USDT",
  timeframe: "4h",
  price: 100,
  atr: 2,
  atrPct: 2,
  ema20: 99,
  ema50: 98,
  ema200: 95,
  rsi: 55,
  volZ: 0.5,
  trend: "UP",
  rsVsBtc: 1,
  levels: [],
  ...over,
});

const CTX = { regime: "NEUTRAL" as const, marketType: "SPOT", now: Date.now() };

describe("levels extraction", () => {
  it("finds a resistance cluster above and support below with source tags", () => {
    const candles = mkCandles(resistancePath());
    const levels = extractLevels(candles, { timeframe: "4h" });
    const price = candles.at(-1)!.close;
    const above = levelsAbove(levels, price);
    const below = levelsBelow(levels, price);
    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
    expect(above[0].price).toBeGreaterThan(price);
    expect(above[0].price).toBeLessThan(price * 1.05);
    for (const l of levels) {
      expect(l.source).toMatch(/سوینگ|کلاستر/);
      expect(l.source).toContain("4h");
      expect(l.strength).toBeGreaterThanOrEqual(0);
      expect(l.strength).toBeLessThanOrEqual(1);
    }
  });

  it("returns no levels on too few candles", () => {
    expect(extractLevels(mkCandles(seg(90, 91, 20)), { timeframe: "4h" })).toEqual([]);
  });
});

describe("setup generation on synthetic candles", () => {
  it("produces a conditional LONG_BREAKOUT near resistance, RR≥1.5, with meta sources", () => {
    const candles = mkCandles(resistancePath());
    const a = analyzePair("TST-USDT", "4h", candles)!;
    expect(a).not.toBeNull();
    const drafts = buildSetups(a, CTX);
    const bo = drafts.find((d) => d.kind === "LONG_BREAKOUT");
    expect(bo).toBeDefined();
    expect(bo!.direction).toBe("LONG");
    expect(bo!.triggerPrice).toBeGreaterThan(a.price);
    expect(bo!.entryHigh).toBeGreaterThanOrEqual(bo!.entryLow);
    expect(bo!.sl).toBeLessThan(bo!.entryLow);
    expect(bo!.tp1).toBeGreaterThan(bo!.entryHigh);
    expect(bo!.rr).toBeGreaterThanOrEqual(MIN_RR);
    expect(bo!.confirmRule).toBe("CLOSE_ABOVE_TF");
    expect(bo!.executable).toBe(true);
    expect(bo!.score).toBeGreaterThanOrEqual(0);
    expect(bo!.score).toBeLessThanOrEqual(100);
    expect(bo!.confidence).toBeGreaterThan(0);
    expect(bo!.confidence).toBeLessThanOrEqual(1);
    const ageH = (bo!.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(ageH).toBeGreaterThanOrEqual(23);
    expect(ageH).toBeLessThanOrEqual(49);
    for (const k of ["trigger", "entry", "sl", "tp1", "tp2", "invalidate"] as const) {
      expect(bo!.levelsMeta[k].length).toBeGreaterThan(0);
    }
    expect(bo!.reasonFa).toContain("مقاومت");
  });

  it("produces a LONG_BOUNCE when price sits on a clustered support", () => {
    const a = analyzePair("TST-USDT", "4h", mkCandles(supportPath()))!;
    const bounce = buildSetups(a, CTX).find((d) => d.kind === "LONG_BOUNCE");
    expect(bounce).toBeDefined();
    expect(bounce!.triggerPrice).toBeLessThan(a.price);
    expect(bounce!.sl).toBeLessThan(bounce!.triggerPrice);
    expect(bounce!.rr).toBeGreaterThanOrEqual(MIN_RR);
  });

  it("returns null for insufficient history", () => {
    expect(analyzePair("X", "4h", mkCandles(seg(90, 91, 50)))).toBeNull();
  });
});

describe("RR filter", () => {
  it("never emits a setup with RR<1.5 — too-close levels fall back to measured move", () => {
    // resistance 0.4 ATR up, support 1 ATR down; nearest level above entry is
    // only ~0.7×risk away so TP1 must come from the 2×risk formula, not the level
    const a = baseAnalysis({
      levels: [
        { price: 100.8, origin: "HIGH", source: "سوینگ 4h", touches: 1, lastIdx: 90, strength: 0.4 },
        { price: 101.6, origin: "HIGH", source: "سوینگ 4h", touches: 1, lastIdx: 80, strength: 0.4 },
        { price: 97.5, origin: "LOW", source: "سوینگ 4h", touches: 2, lastIdx: 60, strength: 0.6 },
      ],
    });
    const drafts = buildSetups(a, CTX);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.rr).toBeGreaterThanOrEqual(MIN_RR);
      const risk = Math.abs((d.entryLow + d.entryHigh) / 2 - d.sl);
      expect(Math.abs(d.tp1 - (d.entryLow + d.entryHigh) / 2) / risk).toBeGreaterThanOrEqual(MIN_RR - 0.01);
    }
    const bo = drafts.find((d) => d.kind === "LONG_BREAKOUT")!;
    // 101.6 is ~0.35×risk past entry — too close → measured-move TP1
    expect(bo.tp1).toBeGreaterThan(101.6);
    expect(bo.levelsMeta.tp1).toContain("R:R");
  });
});

describe("executable flag + direction", () => {
  it("marks SHORT setups non-executable on SPOT, executable on FUTURES", () => {
    const a = baseAnalysis({
      trend: "DOWN",
      levels: [
        { price: 102, origin: "HIGH", source: "سوینگ 4h", touches: 1, lastIdx: 90, strength: 0.4 },
        { price: 99, origin: "LOW", source: "کلاستر 4h ×2", touches: 2, lastIdx: 85, strength: 0.6 },
        { price: 94, origin: "LOW", source: "سوینگ 4h", touches: 1, lastIdx: 40, strength: 0.4 },
      ],
    });
    const spot = buildSetups(a, CTX).find((d) => d.kind === "SHORT_BREAKDOWN")!;
    expect(spot.direction).toBe("SHORT");
    expect(spot.executable).toBe(false);
    const fut = buildSetups(a, { ...CTX, marketType: "FUTURES" }).find((d) => d.kind === "SHORT_BREAKDOWN")!;
    expect(fut.executable).toBe(true);
  });
});

describe("dedupe + persistence", () => {
  const draft = (over: Partial<SetupDraft> = {}): SetupDraft => ({
    symbol: "ETH-USDT",
    direction: "LONG",
    kind: "LONG_BREAKOUT",
    timeframe: "4h",
    triggerPrice: 2100,
    confirmRule: "CLOSE_ABOVE_TF",
    entryLow: 2100,
    entryHigh: 2130,
    tp1: 2250,
    tp2: 2350,
    sl: 2050,
    invalidatePrice: 1980,
    rr: 2,
    score: 70,
    confidence: 0.7,
    reasonFa: "شکست مقاومت",
    levelsMeta: { trigger: "سوینگ 4h", entry: "سوینگ 4h ±ATR", sl: "ATR×1.2", tp1: "کلاستر 4h ×2", tp2: "سوینگ 4h", invalidate: "سوینگ 4h" },
    expiresAt: new Date(Date.now() + 36 * 3_600_000),
    priceAtScan: 2050,
    executable: true,
    ...over,
  });

  it("refreshes an active setup on same symbol+direction instead of duplicating", async () => {
    const user = await prisma.user.create({ data: { username: "sfsetups", passwordHash: "x", referralCode: "SFS1" } });
    const cfg = await getOrCreateConfig(user.id);

    const r1 = await persistSetups(cfg, [draft()], "NEUTRAL");
    expect(r1.created).toBe(1);
    expect(await prisma.setup.count({ where: { configId: cfg.id } })).toBe(1);

    // same symbol+direction, updated prices → same row refreshed
    const r2 = await persistSetups(cfg, [draft({ score: 80, triggerPrice: 2110 })], "NEUTRAL");
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(1);
    const rows = await prisma.setup.findMany({ where: { configId: cfg.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(80);
    expect(rows[0].triggerPrice).toBe(2110);
    expect(rows[0].backtestLabel).toBe("NOT_TESTED");

    // opposite direction is a different setup
    const r3 = await persistSetups(cfg, [draft({ direction: "SHORT", kind: "SHORT_BREAKDOWN", executable: false })], "NEUTRAL");
    expect(r3.created).toBe(1);
    const shorts = await prisma.setup.findMany({ where: { configId: cfg.id, direction: "SHORT" } });
    expect(shorts[0].executable).toBe(false);

    // SetupType rows were upserted with kind+paramsHash keys
    const types = await prisma.setupType.findMany();
    expect(types.length).toBeGreaterThanOrEqual(2);
    expect(types.every((t) => t.key.startsWith(`${t.kind}:`))).toBe(true);
  });

  it("caps a symbol at 2 setups and keeps the top-10 by score", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      draft({ symbol: `S${i % 3}-USDT`, score: 90 - i * 10 }));
    const ranked = rankTop(many, 10, 2);
    expect(ranked.length).toBe(6);
    const perSymbol = new Map<string, number>();
    for (const d of ranked) perSymbol.set(d.symbol, (perSymbol.get(d.symbol) ?? 0) + 1);
    for (const c of perSymbol.values()) expect(c).toBeLessThanOrEqual(2);
    // ordering preserved by score
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked.at(-1)!.score);
    const capped = rankTop(Array.from({ length: 15 }, (_, i) => draft({ symbol: `Z${i}-USDT`, score: i })));
    expect(capped).toHaveLength(10);
  });
});

describe("market context helpers", () => {
  it("classifies trend vs EMAs and volatility regime", () => {
    const up = mkCandles(seg(80, 120, 220));
    expect(trendOf(up)).toBe("UP");
    const down = mkCandles(seg(120, 80, 220));
    expect(trendOf(down)).toBe("DOWN");
    expect(regimeOf("UP", "UP", "NORMAL")).toBe("AGGRESSIVE");
    expect(regimeOf("UP", "DOWN", "LOW")).toBe("DEFENSIVE");
    expect(regimeOf("RANGE", "RANGE", "NORMAL")).toBe("NEUTRAL");
    expect(volatilityOf(up).volatility).toBeDefined();
  });
});
