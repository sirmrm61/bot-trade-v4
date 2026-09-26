import { describe, it, expect } from "vitest";
import { planQuotes, diffQuotes, readMmConfig, midPrice, simulatePaperFills, type MmConfig, type PaperQuote } from "@/modules/trading/market-making";
import type { OrderBook } from "@/modules/exchanges/types";

const cfg = (over: Partial<MmConfig> = {}): MmConfig => ({
  spreadPct: 1,
  orderSizePct: 10,
  levels: 1,
  levelStepPct: 1,
  requotePct: 0.1,
  maxInventoryPct: 60,
  ...over,
});

const base = {
  allocatedCapital: 10_000,
  quoteFree: 10_000,
  baseFree: 10,
  baseTotal: 0,
  pricePrecision: 2,
  amountPrecision: 8,
  minAmount: 0,
};

describe("planQuotes", () => {
  it("quotes bid and ask symmetric around mid", () => {
    const q = planQuotes({ mid: 100, cfg: cfg(), ...base });
    expect(q).toHaveLength(2);
    const bid = q.find((x) => x.side === "BUY")!;
    const ask = q.find((x) => x.side === "SELL")!;
    expect(bid.price).toBeCloseTo(99.5, 6); // 100 * (1 - 0.5%)
    expect(ask.price).toBeCloseTo(100.5, 6);
    expect(bid.amount).toBeCloseTo(1000 / 99.5, 4); // 10% of capital
    expect(ask.amount).toBeCloseTo(1000 / 100.5, 4);
  });

  it("stops buying when inventory exceeds maxInventoryPct", () => {
    const q = planQuotes({ mid: 100, cfg: cfg({ maxInventoryPct: 50 }), ...base, baseTotal: 60 }); // 6000/10000 = 60%
    expect(q.some((x) => x.side === "BUY")).toBe(false);
    expect(q.some((x) => x.side === "SELL")).toBe(true);
  });

  it("skips sell quotes without base balance", () => {
    const q = planQuotes({ mid: 100, cfg: cfg(), ...base, baseFree: 0 });
    expect(q.some((x) => x.side === "SELL")).toBe(false);
  });

  it("skips buy quotes without quote balance", () => {
    const q = planQuotes({ mid: 100, cfg: cfg(), ...base, quoteFree: 0 });
    expect(q.some((x) => x.side === "BUY")).toBe(false);
  });

  it("places multi-level quotes with levelStepPct spacing", () => {
    const q = planQuotes({ mid: 100, cfg: cfg({ levels: 3, spreadPct: 1, levelStepPct: 0.5 }), ...base, baseFree: 100 });
    const bids = q.filter((x) => x.side === "BUY").map((x) => x.price);
    const asks = q.filter((x) => x.side === "SELL").map((x) => x.price);
    expect(bids).toEqual([99.5, 99, 98.5]);
    expect(asks).toEqual([100.5, 101, 101.5]);
  });

  it("returns nothing for invalid mid", () => {
    expect(planQuotes({ mid: 0, cfg: cfg(), ...base })).toEqual([]);
  });
});

describe("diffQuotes", () => {
  const order = (id: string, side: string, price: number) => ({ id, side, price });

  it("keeps orders within requotePct of desired price", () => {
    const open = [order("o1", "BUY", 99.55), order("o2", "SELL", 100.45)];
    const desired = [
      { side: "BUY" as const, price: 99.5, amount: 1 },
      { side: "SELL" as const, price: 100.5, amount: 1 },
    ];
    const d = diffQuotes(open, desired, 0.1); // ±0.1% of ~100 = 0.1
    expect(d.keep).toEqual(["o1", "o2"]);
    expect(d.cancels).toEqual([]);
    expect(d.placements).toEqual([]);
  });

  it("cancels drifted orders and places fresh ones", () => {
    const open = [order("o1", "BUY", 90)];
    const desired = [{ side: "BUY" as const, price: 99.5, amount: 1 }];
    const d = diffQuotes(open, desired, 0.1);
    expect(d.cancels.map((o) => o.id)).toEqual(["o1"]);
    expect(d.placements).toHaveLength(1);
  });

  it("cancels orders for sides no longer desired", () => {
    const open = [order("o1", "SELL", 100.5)];
    const d = diffQuotes(open, [], 0.1);
    expect(d.cancels.map((o) => o.id)).toEqual(["o1"]);
  });

  it("ignores orders without a price", () => {
    const open = [{ id: "o1", side: "BUY", price: null }];
    const d = diffQuotes(open, [{ side: "BUY", price: 99.5, amount: 1 }], 0.1);
    expect(d.placements).toHaveLength(1); // priceless order can't match → fresh placement
  });
});

describe("simulatePaperFills", () => {
  const quote = (id: number, side: "BUY" | "SELL", price: number): PaperQuote =>
    ({ id, side, price, amount: 1 });

  it("fills a bid when best ask drops to it", () => {
    const { filled, open } = simulatePaperFills([quote(1, "BUY", 99)], 100.5, 99);
    expect(filled.map((q) => q.id)).toEqual([1]);
    expect(open).toEqual([]);
  });

  it("fills an ask when best bid rises to it", () => {
    const { filled } = simulatePaperFills([quote(1, "SELL", 101)], 101, 102);
    expect(filled.map((q) => q.id)).toEqual([1]);
  });

  it("keeps untouched quotes open", () => {
    const { filled, open } = simulatePaperFills(
      [quote(1, "BUY", 98), quote(2, "SELL", 102)],
      100, 100.5,
    );
    expect(filled).toEqual([]);
    expect(open).toHaveLength(2);
  });
});

describe("readMmConfig / midPrice", () => {
  it("applies defaults", () => {
    expect(readMmConfig("{}")).toEqual({
      spreadPct: 0.6, orderSizePct: 10, levels: 1,
      levelStepPct: 0.6, requotePct: 0.1, maxInventoryPct: 60,
    });
  });

  it("computes mid from best bid/ask", () => {
    const book: OrderBook = { bids: [[99, 1]], asks: [[101, 1]], ts: 0 };
    expect(midPrice(book)).toBe(100);
    expect(midPrice({ bids: [], asks: [], ts: 0 })).toBeNull();
    expect(midPrice({ bids: [[99, 1]], asks: [], ts: 0 })).toBe(99);
  });
});
