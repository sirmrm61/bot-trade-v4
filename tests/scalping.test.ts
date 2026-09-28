import { describe, it, expect } from "vitest";
import { mergeScalpConfig, SCALPING_DEFAULTS } from "@/modules/scalping/config";
import { scorePair } from "@/modules/scalping/scorer";
import {
  spreadPct, bookDepthQuote, walkBook, realizedVolPct,
} from "@/modules/scalping/metrics";
import type { PairSnapshot } from "@/modules/scalping/types";
import type { Candle, OrderBook } from "@/modules/exchanges/types";

const CTX = { orderSizeUsd: 100, irtPerUsd: 2_400_000, now: 1_800_000_000_000 };

function snap(over: Partial<PairSnapshot> = {}): PairSnapshot {
  return {
    symbol: "BTCUSDT", baseCurrency: "BTC", quoteCurrency: "USDT",
    exchange: "NOBITEX", marketType: "SPOT",
    stats: {
      symbol: "BTCUSDT", baseCurrency: "BTC", quoteCurrency: "USDT",
      last: 100, bid: 99.9, ask: 100.1,
      high24h: 104, low24h: 98, change24hPct: 1.5,
      volumeQuote24h: 2_000_000, isClosed: false, ts: CTX.now,
    },
    statsTs: CTX.now,
    ...over,
  };
}

function book(mid = 100, spread = 0.1, levelQuote = 10_000, levels = 30): OrderBook {
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];
  for (let i = 0; i < levels; i++) {
    const bp = mid - spread / 2 - i * 0.05;
    const ap = mid + spread / 2 + i * 0.05;
    bids.push([bp, levelQuote / bp]);
    asks.push([ap, levelQuote / ap]);
  }
  return { bids, asks, ts: CTX.now };
}

function candles(n = 48, drift = 0.2): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1 + ((i % 2 ? 1 : -1) * drift) / 100; // alternating ±drift%
    out.push({
      time: CTX.now - (n - i) * 300_000,
      open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      close: price, volume: 10,
    });
  }
  return out;
}

const cfg = SCALPING_DEFAULTS;

describe("metrics", () => {
  it("spreadPct computes (ask-bid)/mid", () => {
    expect(spreadPct(99.9, 100.1)).toBeCloseTo(0.2, 3);
    expect(spreadPct(0, 100)).toBeNull();
    expect(spreadPct(101, 100)).toBeNull(); // crossed book
  });

  it("bookDepthQuote sums quote value inside the band only", () => {
    const b = { bids: [[99.6, 1], [98, 1]], asks: [[100.4, 1], [102, 1]], ts: 0 } as OrderBook;
    // ±0.5% of 100 → [99.5, 100.5]; 98 and 102 outside
    expect(bookDepthQuote(b, 100, 0.5)).toBeCloseTo(99.6 + 100.4, 3);
  });

  it("walkBook walks multiple levels and reports slippage vs mid", () => {
    // thin book: each level only covers 50 quote units
    const b: OrderBook = {
      bids: [[99.9, 0.5], [99.5, 0.5]],
      asks: [[100.1, 0.5], [100.5, 0.5], [101, 0.5]],
      ts: 0,
    };
    const r = walkBook(b, "buy", 100, 100);
    expect(r.fullyFilled).toBe(true); // asks cover 50.05+50.25+50.5 = 150.8 ≥ 100
    expect(r.slippagePct!).toBeGreaterThan(0);
    expect(r.avgPrice!).toBeGreaterThan(100);
  });

  it("walkBook reports unfilled when book is too thin", () => {
    const b: OrderBook = { bids: [[99, 0.01]], asks: [[101, 0.01]], ts: 0 };
    const r = walkBook(b, "buy", 1_000_000, 100);
    expect(r.fullyFilled).toBe(false);
    expect(r.filledQuote).toBeCloseTo(1.01, 2);
  });

  it("realizedVolPct measures per-candle dispersion", () => {
    const flat = candles(10, 0);
    expect(realizedVolPct(flat)).toBe(0);
    const moving = candles(20, 0.5);
    expect(realizedVolPct(moving)!).toBeGreaterThan(0.4);
    expect(realizedVolPct([])).toBeNull();
  });
});

describe("scorePair", () => {
  it("ranks a healthy liquid pair", () => {
    const r = scorePair(snap({ book: book(), bookTs: CTX.now, candles: candles() }), cfg, CTX);
    expect(r.status).toBe("RANKED");
    expect(r.score!).toBeGreaterThan(50);
    expect(r.dataQuality.completeness).toBe(1);
    expect(r.partial).toBe(false);
    expect(r.metrics.roundTripCostPct).toBeCloseTo(
      r.metrics.slippageBuyPct! + r.metrics.slippageSellPct! + 2 * cfg.feePctPerSide, 6);
  });

  it("excludes pairs under the volume floor", () => {
    const low = snap();
    low.stats!.volumeQuote24h = 100; // $100
    const r = scorePair(low, cfg, CTX);
    expect(r.status).toBe("EXCLUDED");
    expect(r.reasons.join()).toContain("حجم");
    expect(r.score).toBeNull();
  });

  it("excludes pairs with excessive spread", () => {
    const wide = snap();
    wide.stats!.bid = 95; wide.stats!.ask = 105; // ~10% spread
    const r = scorePair(wide, cfg, CTX);
    expect(r.status).toBe("EXCLUDED");
    expect(r.reasons.join()).toContain("اسپرد");
  });

  it("excludes pairs whose book cannot absorb the hypothetical order", () => {
    const thin: OrderBook = {
      bids: [[99.9, 0.5]], asks: [[100.1, 0.5]], // almost no depth
      ts: CTX.now,
    };
    const r = scorePair(snap({ book: thin, bookTs: CTX.now, candles: candles() }), cfg,
      { ...CTX, orderSizeUsd: 50_000 });
    expect(r.status).toBe("EXCLUDED");
    expect(r.reasons.join()).toContain("عمق");
  });

  it("excludes pairs whose round-trip cost is too high even with depth", () => {
    // deep enough to fill $5k, but price levels are far from mid → huge slippage
    const gaps: OrderBook = {
      bids: [[99.9, 5], [95, 10], [90, 20], [80, 50]],
      asks: [[100.1, 5], [105, 10], [110, 20], [120, 50]],
      ts: CTX.now,
    };
    const c = mergeScalpConfig({ maxCostPct: 2.5 });
    const r = scorePair(snap({ book: gaps, bookTs: CTX.now, candles: candles() }), c,
      { ...CTX, orderSizeUsd: 1_000 });
    expect(r.status).toBe("EXCLUDED");
    expect(r.reasons.join()).toContain("هزینه");
  });

  it("marks stale order book as unusable and degrades gracefully", () => {
    const staleBook = book();
    staleBook.ts = CTX.now - 600_000; // 10 min old
    const r = scorePair(
      snap({ book: staleBook, bookTs: staleBook.ts, candles: candles() }),
      mergeScalpConfig({ minCompleteness: 0.4 }),
      CTX,
    );
    expect(r.dataQuality.stale).toContain("orderbook");
    expect(r.metrics.slippagePct).toBeFalsy();
    expect(r.metrics.depthUsd).toBeFalsy();
  });

  it("marks stale candles and falls back to 24h range estimate", () => {
    const old = candles(); old.forEach((c) => { c.time -= 3_600_000; });
    const r = scorePair(snap({ book: book(), bookTs: CTX.now, candles: old, candleAgeMs: 3_600_000 }), cfg, CTX);
    expect(r.dataQuality.stale).toContain("candles");
    expect(r.metrics.volatilityEstimated).toBe(true);
    expect(r.metrics.volatilityPct).toBeCloseTo(r.metrics.dayRangePct!, 6);
  });

  it("scores without book/candles as partial (weights renormalize)", () => {
    const r = scorePair(snap(), cfg, CTX);
    expect(r.status).toBe("RANKED");
    expect(r.partial).toBe(true);
    expect(r.dataQuality.completeness).toBeLessThan(1);
    const volCrit = r.criteria.find((c) => c.key === "volatility")!;
    expect(volCrit.note).toContain("۲۴ساعته");
  });

  it("reports NO_DATA when too little data exists", () => {
    const bare = snap();
    bare.stats = undefined; bare.statsTs = undefined;
    const r = scorePair(bare, cfg, CTX);
    expect(r.status).toBe("NO_DATA");
    expect(r.score).toBeNull();
  });

  it("converts IRT volume to USD via the reference rate", () => {
    const irt = snap();
    irt.symbol = "BTCIRT"; irt.quoteCurrency = "IRT";
    irt.stats!.quoteCurrency = "IRT";
    irt.stats!.volumeQuote24h = 2_400_000_000_000; // ≈ $1M IRT
    irt.stats!.bid = 240_000_000_000; irt.stats!.ask = 240_100_000_000;
    const r = scorePair(irt, cfg, CTX);
    expect(r.metrics.volumeUsd24h).toBeCloseTo(1_000_000, 0);
  });

  it("flags missing conversion rate instead of inventing USD volume", () => {
    const irt = snap();
    irt.quoteCurrency = "IRT"; irt.stats!.quoteCurrency = "IRT";
    irt.stats!.volumeQuote24h = 1e12;
    irt.stats!.bid = 100; irt.stats!.ask = 100.1;
    const r = scorePair(irt, cfg, { ...CTX, irtPerUsd: null });
    expect(r.metrics.volumeUsd24h).toBeNull();
    expect(r.dataQuality.issues.join()).toContain("حجم دلاری");
  });

  it("respects custom weights — zero-weight criteria do not drag the score", () => {
    const c = mergeScalpConfig({ weights: { liquidity: 100, spread: 0, depth: 0, slippage: 0, volatility: 0, cost: 0 } });
    const r = scorePair(snap(), c, CTX);
    expect(r.status).toBe("RANKED");
    const liq = r.criteria.find((x) => x.key === "liquidity")!;
    expect(r.score).toBe(Math.round(liq.score!));
  });

  it("mergeScalpConfig clamps garbage input", () => {
    const c = mergeScalpConfig({ orderSizeUsd: -5, bookLimit: 9999, candleTimeframe: "7d", weights: { liquidity: 500 } });
    expect(c.orderSizeUsd).toBe(1);
    expect(c.bookLimit).toBe(300);
    expect(c.candleTimeframe).toBe("5m");
    expect(c.weights.liquidity).toBe(100);
  });
});
