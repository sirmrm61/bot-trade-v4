import { describe, it, expect } from "vitest";
import type { Candle, OrderBook } from "@/modules/exchanges/types";
import { detectWhales, WHALE_DEFAULTS } from "@/modules/whales/engine";
import { planGrid, gridLevels, gridStepPct, readGridConfig, type GridConfig } from "@/modules/trading/grid";
import { runGridBacktest } from "@/modules/backtest/grid-engine";

const cfg = WHALE_DEFAULTS;
const BOOK_LEVELS = 20;

/** uniform book — no whale */
function flatBook(mid = 100, depth = 10): OrderBook {
  const mk = (side: 1 | -1) =>
    Array.from({ length: BOOK_LEVELS }, (_, i) => [mid + side * (0.5 + i * 0.1), depth] as [number, number]);
  return { bids: mk(-1), asks: mk(1), ts: Date.now() };
}

function bookWithBidWall(mid = 100): OrderBook {
  const b = flatBook(mid);
  b.bids[4] = [mid - 0.9, 8000]; // huge wall ~$800K vs ~$20K normal levels
  return b;
}

function imbalancedBook(mid = 100): OrderBook {
  const b = flatBook(mid);
  b.bids = b.bids.map(([p, a]) => [p, a * 40] as [number, number]); // 40× bid depth
  return b;
}

describe("whale engine", () => {
  it("detects a bid wall with size/share/distance", () => {
    const events = detectWhales(bookWithBidWall(), { ...cfg, minWallUsd: 10_000, wallSharePct: 10 });
    const wall = events.find((e) => e.kind === "BID_WALL");
    expect(wall).toBeDefined();
    expect(wall!.price).toBeCloseTo(99.1, 5);
    expect(wall!.sizeUsd!).toBeGreaterThan(700_000);
    expect(wall!.sharePct!).toBeGreaterThan(10);
    expect(wall!.score).toBeGreaterThan(0);
    expect(wall!.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("detects bid-side imbalance", () => {
    const events = detectWhales(imbalancedBook(), { ...cfg, minWallUsd: 1e9 });
    expect(events.some((e) => e.kind === "IMBALANCE_BIDS")).toBe(true);
  });

  it("flat book → no events", () => {
    expect(detectWhales(flatBook(), cfg)).toEqual([]);
  });

  it("empty book → no events, no crash", () => {
    expect(detectWhales({ bids: [], asks: [], ts: 0 }, cfg)).toEqual([]);
    expect(detectWhales({ bids: [[99, 1]], asks: [], ts: 0 }, cfg)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const GRID_CFG: GridConfig = {
  rangePct: 4, levels: 5, stepPct: 0.8, atrStepMult: 1.2,
  orderSizePct: 15, recenterPct: 4, requotePct: 0.1, maxInventoryPct: 80,
};

describe("grid — planning", () => {
  it("levels sit symmetric around anchor, inside the band", () => {
    const lv = gridLevels(100, 1, 3, 4, 2);
    expect(lv.buy).toEqual([99, 98, 97]);
    expect(lv.sell).toEqual([101, 102, 103]);
  });

  it("smart step = max(config floor, ATR × mult)", () => {
    expect(gridStepPct(GRID_CFG, 0.5)).toBe(0.8);        // 0.5×1.2=0.6 < 0.8 floor
    expect(gridStepPct(GRID_CFG, 2)).toBeCloseTo(2.4);   // ATR wins in wild market
    expect(gridStepPct(GRID_CFG, null)).toBe(0.8);       // no ATR → floor
  });

  it("plans buys funded by quote, sells funded by inventory", () => {
    const q = planGrid({
      anchor: 100, stepPct: 0.8, cfg: GRID_CFG,
      allocatedCapital: 1000, quoteFree: 1000, baseFree: 0, baseTotal: 0, mid: 100,
      pricePrecision: 2, amountPrecision: 4,
    });
    const buys = q.filter((o) => o.side === "BUY");
    const sells = q.filter((o) => o.side === "SELL");
    expect(buys.length).toBe(5);
    expect(sells.length).toBe(0);               // nothing to sell yet
    expect(buys.every((b) => b.price < 100)).toBe(true);
    // funded ~orderSizePct each until quote runs out
    expect(buys[0].price * buys[0].amount).toBeCloseTo(150, 0);
  });

  it("sells appear once base inventory exists, split across rungs", () => {
    const q = planGrid({
      anchor: 100, stepPct: 0.8, cfg: GRID_CFG,
      allocatedCapital: 1000, quoteFree: 0, baseFree: 2, baseTotal: 2, mid: 100,
      pricePrecision: 2, amountPrecision: 4,
    });
    const sells = q.filter((o) => o.side === "SELL");
    expect(sells.length).toBe(5);
    expect(sells.every((s) => s.price > 100)).toBe(true);
    expect(sells.reduce((s, o) => s + o.amount, 0)).toBeCloseTo(2, 3);
    expect(q.filter((o) => o.side === "BUY").length).toBe(0); // quoteFree=0
  });

  it("stops buying when inventory exceeds maxInventoryPct", () => {
    const q = planGrid({
      anchor: 100, stepPct: 0.8, cfg: GRID_CFG,
      allocatedCapital: 1000, quoteFree: 1000, baseFree: 9, baseTotal: 9, mid: 100, // 90% > 80%
      pricePrecision: 2, amountPrecision: 4,
    });
    expect(q.filter((o) => o.side === "BUY").length).toBe(0);
  });
});

describe("grid — backtest", () => {
  /** oscillating market — grid's bread and butter */
  function rangeCandles(n: number): Candle[] {
    return Array.from({ length: n }, (_, i) => {
      const p = 100 + Math.sin(i * 0.5) * 2;
      return { time: i * 60_000, open: p, high: p * 1.012, low: p * 0.988, close: p, volume: 50 };
    });
  }

  it("harvests cycles in a ranging market", () => {
    const res = runGridBacktest({
      candles: rangeCandles(400), cfg: GRID_CFG,
      initialBalance: 1000, feePct: 0.1, pricePrecision: 2, amountPrecision: 4,
    });
    expect(res.totalTrades).toBeGreaterThan(0);
    expect(res.finalBalance).toBeGreaterThan(900); // not catastrophic
  });

  it("recentering follows a strong trend out of band", () => {
    const trending = Array.from({ length: 300 }, (_, i) => {
      const p = 100 * (1 + i * 0.002);
      return { time: i * 60_000, open: p, high: p * 1.005, low: p * 0.995, close: p, volume: 50 };
    });
    const res = runGridBacktest({
      candles: trending, cfg: GRID_CFG,
      initialBalance: 1000, feePct: 0.1, pricePrecision: 2, amountPrecision: 4,
    });
    // grid sells inventory on the way up and stops buying — shouldn't blow up
    expect(Number.isFinite(res.finalBalance)).toBe(true);
    expect(res.finalBalance).toBeGreaterThan(0);
  });

  it("higher fees reduce net PnL", () => {
    const candles = rangeCandles(400);
    const cheap = runGridBacktest({ candles, cfg: GRID_CFG, initialBalance: 1000, feePct: 0.05, pricePrecision: 2, amountPrecision: 4 });
    const dear = runGridBacktest({ candles, cfg: GRID_CFG, initialBalance: 1000, feePct: 0.5, pricePrecision: 2, amountPrecision: 4 });
    expect(dear.finalBalance).toBeLessThan(cheap.finalBalance);
  });
});

describe("grid — config parsing", () => {
  it("defaults apply when config is empty", () => {
    const c = readGridConfig("{}");
    expect(c.levels).toBe(5);
    expect(c.stepPct).toBe(0.8);
    expect(c.rangePct).toBe(4);
  });

  it("reads persisted grid config", () => {
    const c = readGridConfig(JSON.stringify({ grid: { levels: 8, stepPct: 1.5, rangePct: 10 } }));
    expect(c.levels).toBe(8);
    expect(c.stepPct).toBe(1.5);
    expect(c.recenterPct).toBe(10); // falls back to rangePct
  });
});
