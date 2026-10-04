import { describe, it, expect } from "vitest";
import { orderBookImbalance, smoothObi, readObiConfig, obiHysteresis } from "@/modules/trading/orderbook-imbalance";
import type { OrderBook } from "@/modules/exchanges/types";

const book = (bids: [number, number][], asks: [number, number][]): OrderBook => ({
  bids, asks, ts: 0,
});

describe("orderBookImbalance", () => {
  it("returns +1 when the book is all bids", () => {
    expect(orderBookImbalance(book([[100, 5], [99, 5]], []), 10)).toBe(1);
  });

  it("returns -1 when the book is all asks", () => {
    expect(orderBookImbalance(book([], [[101, 3], [102, 3]]), 10)).toBe(-1);
  });

  it("returns 0 on a symmetric book", () => {
    expect(orderBookImbalance(book([[100, 4], [99, 4]], [[101, 4], [102, 4]]), 10)).toBe(0);
  });

  it("weights volume correctly", () => {
    // bids 10, asks 5 → (10-5)/15 = 1/3
    const v = orderBookImbalance(book([[100, 10]], [[101, 5]]), 10);
    expect(v).toBeCloseTo(1 / 3, 6);
  });

  it("respects depthLevels", () => {
    // top level is bid-heavy, deep levels are ask-heavy
    const v1 = orderBookImbalance(book([[100, 100]], [[101, 1], [102, 1000]]), 1);
    const vAll = orderBookImbalance(book([[100, 100]], [[101, 1], [102, 1000]]), 10);
    expect(v1).toBeGreaterThan(0.9);
    expect(vAll).toBeLessThan(0);
  });

  it("returns 0 for an empty book", () => {
    expect(orderBookImbalance(book([], []), 10)).toBe(0);
  });
});

describe("smoothObi", () => {
  it("passes raw value through when emaPeriod is 1", () => {
    expect(smoothObi(0.8, 0.2, 1)).toBe(0.8);
  });

  it("initializes to raw on first tick", () => {
    expect(smoothObi(0.5, undefined, 10)).toBe(0.5);
  });

  it("blends with previous EMA", () => {
    // alpha = 2/(4+1) = 0.4 → 0.4*1 + 0.6*0 = 0.4
    expect(smoothObi(1, 0, 4)).toBeCloseTo(0.4, 6);
  });
});

describe("readObiConfig", () => {
  it("applies defaults — smoothed + hysteresis on", () => {
    expect(readObiConfig("{}")).toEqual({ depthLevels: 10, emaPeriod: 10, hysteresis: 3 });
  });

  it("reads nested config and clamps ranges", () => {
    const cfg = readObiConfig(JSON.stringify({ orderBookImbalance: { depthLevels: 500, emaPeriod: 5, hysteresis: 99 } }));
    expect(cfg.depthLevels).toBe(50);
    expect(cfg.emaPeriod).toBe(5);
    expect(cfg.hysteresis).toBe(50);
  });
});

describe("obiHysteresis", () => {
  it("blocks a direction until it persists N ticks", () => {
    let cand: "BUY" | "SELL" | undefined;
    let n = 0;
    const tick = (dir: "BUY" | "SELL" | "HOLD") => {
      const g = obiHysteresis(dir, cand, n, 3);
      cand = g.cand; n = g.candN;
      return g.signal;
    };
    expect(tick("BUY")).toBe("HOLD");  // 1/3
    expect(tick("BUY")).toBe("HOLD");  // 2/3
    expect(tick("BUY")).toBe("BUY");   // 3/3 — fires
  });

  it("resets the counter when the direction flips", () => {
    let cand: "BUY" | "SELL" | undefined;
    let n = 0;
    const tick = (dir: "BUY" | "SELL" | "HOLD") => {
      const g = obiHysteresis(dir, cand, n, 2);
      cand = g.cand; n = g.candN;
      return g.signal;
    };
    expect(tick("SELL")).toBe("HOLD"); // SELL 1/2
    expect(tick("BUY")).toBe("HOLD");  // flip → BUY 1/2 (counter reset)
    expect(tick("BUY")).toBe("BUY");   // BUY 2/2
  });

  it("clears the candidate on HOLD and passes through when hysteresis=0", () => {
    const g1 = obiHysteresis("HOLD", "SELL", 5, 3);
    expect(g1.candN).toBe(0);
    expect(obiHysteresis("BUY", undefined, 0, 0).signal).toBe("BUY");
    expect(obiHysteresis("BUY", undefined, 0, 1).signal).toBe("BUY");
  });
});
