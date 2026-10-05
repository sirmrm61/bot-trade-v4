import { describe, it, expect } from "vitest";
import { validateStrategyInput } from "@/modules/strategies/service";
import { readPaConfig, paSignalFn, paSignal, paWarmup, PA_SETUPS } from "@/modules/trading/price-action";
import { ema } from "@/modules/indicators/engine";
import type { Candle } from "@/modules/exchanges/types";

type Quad = [number, number, number, number, number?]; // [o,h,l,c,vol?]

const candles = (list: Quad[]): Candle[] =>
  list.map(([o, h, l, c, v], i) => ({ time: i * 60_000, open: o, high: h, low: l, close: c, volume: v ?? 100 }));

/** flat history — no swings, tiny ATR, no patterns */
const flat = (n: number, p = 100): Quad[] =>
  Array.from({ length: n }, () => [p - 0.05, p + 0.1, p - 0.1, p + 0.05]);

/** gentle uptrend — used for EMA-anchored setups */
const rise = (n: number, step = 0.05): Quad[] =>
  Array.from({ length: n }, (_, i) => {
    const p = 100 + i * step;
    return [p - 0.02, p + 0.1, p - 0.08, p + 0.05];
  });

const cfg = (setup: string, extra: Record<string, number | string> = {}) =>
  JSON.stringify({ priceAction: { setup, ...extra } });

const sigAt = (setup: string, list: Quad[], extra: Record<string, number | string> = {}) => {
  const cs = candles(list);
  return paSignalFn(cfg(setup, extra), cs)(cs.length - 1);
};

describe("PRICE_ACTION — config & validation", () => {
  it("has all 16 setups registered", () => {
    expect(PA_SETUPS).toHaveLength(16);
  });

  it("reads defaults and clamps out-of-range values", () => {
    const c = readPaConfig(JSON.stringify({}));
    expect(c).toMatchObject({ setup: "PIN_BAR", lookback: 60, swingLen: 3, zoneTolPct: 0.3, emaPeriod: 50 });
    const bad = readPaConfig(JSON.stringify({ priceAction: { setup: "NOPE", lookback: 99999, swingLen: 0 } }));
    expect(bad.setup).toBe("PIN_BAR");
    expect(bad.lookback).toBe(500);
    expect(bad.swingLen).toBe(1);
  });

  it("warmup covers lookback + ema", () => {
    expect(paWarmup(JSON.stringify({}))).toBeGreaterThanOrEqual(80);
  });

  it("validateStrategyInput accepts PRICE_ACTION and rejects a bad setup", () => {
    const base = {
      name: "pa", symbol: "BTCUSDT", timeframe: "15m", kind: "PRICE_ACTION" as const,
      buyThreshold: 0.35, sellThreshold: -0.35, riskPerTradePct: 1, stopLossPct: 1,
      takeProfitPct: 2, indicators: [],
    };
    expect(() => validateStrategyInput({ ...base, priceAction: { setup: "ENGULFING" } })).not.toThrow();
    expect(() => validateStrategyInput({ ...base, priceAction: { setup: "BOGUS" } })).toThrow();
    expect(() => validateStrategyInput({ ...base, priceAction: { zoneTolPct: 99 } })).toThrow();
  });
});

describe("candle patterns", () => {
  it("PIN_BAR fires BUY on a long lower wick and SELL on a long upper wick", () => {
    const buy = sigAt("PIN_BAR", [...flat(60), [99.8, 100.1, 98, 100]]);
    expect(buy).toBe("BUY");
    const sell = sigAt("PIN_BAR", [...flat(60), [100.2, 102, 99.9, 100]]);
    expect(sell).toBe("SELL");
    // normal candle → no signal
    expect(sigAt("PIN_BAR", [...flat(60), [99.9, 100.6, 99.4, 100.3]])).toBe("HOLD");
  });

  it("ENGULFING fires BUY when a bullish body swallows a bearish one", () => {
    const list: Quad[] = [...flat(60), [100.5, 100.6, 99.4, 99.5], [99.4, 100.8, 99.3, 100.7]];
    expect(sigAt("ENGULFING", list)).toBe("BUY");
  });

  it("INSIDE_BAR fires BUY when price breaks the mother high", () => {
    const list: Quad[] = [...flat(60), [100, 102, 98, 101], [100.5, 101, 99, 100.2], [101, 102.6, 100.8, 102.5]];
    expect(sigAt("INSIDE_BAR", list)).toBe("BUY");
    const sell: Quad[] = [...flat(60), [101, 102, 98, 99.5], [100, 101, 99, 100], [100, 100.5, 97.5, 97.8]];
    expect(sigAt("INSIDE_BAR", sell)).toBe("SELL");
  });

  it("STAR fires BUY on morning star and SELL on evening star", () => {
    const morning: Quad[] = [...flat(60), [101, 101.5, 98.5, 99], [99, 99.3, 98.8, 99.1], [99.2, 100.7, 99.1, 100.5]];
    expect(sigAt("STAR", morning)).toBe("BUY");
    const evening: Quad[] = [...flat(60), [99, 101.5, 98.8, 101], [101, 101.3, 100.8, 101.1], [101, 101.2, 99.2, 99.5]];
    expect(sigAt("STAR", evening)).toBe("SELL");
  });

  it("MOMENTUM_CANDLE fires BUY on a big full-body candle with volume", () => {
    expect(sigAt("MOMENTUM_CANDLE", [...flat(60), [99.9, 105.5, 99.8, 105, 300]])).toBe("BUY");
    // same candle without volume → HOLD when volMult > 0
    expect(sigAt("MOMENTUM_CANDLE", [...flat(60), [99.9, 105.5, 99.8, 105]])).toBe("HOLD");
    // volMult 0 disables the volume check
    expect(sigAt("MOMENTUM_CANDLE", [...flat(60), [99.9, 105.5, 99.8, 105]], { volMult: 0 })).toBe("BUY");
  });
});

describe("market structure", () => {
  const bosBase = (): Quad[] => [
    ...flat(60),
    [99.9, 105, 99.8, 100.1],               // swing high @60 → 105
    [100, 102, 99.5, 100.2],
    [100.2, 102, 99.6, 100.1],
    [100.1, 102, 99.7, 100.2],              // 3 confirms — swing locked
  ];

  it("BOS fires BUY when close breaks the last swing high", () => {
    expect(sigAt("BOS", [...bosBase(), [103, 106, 102.9, 105.5]])).toBe("BUY");
    // close below the level → no break
    expect(sigAt("BOS", [...bosBase(), [104, 104.9, 103, 104.5]])).toBe("HOLD");
  });

  it("CHoCH fires BUY when a downtrend structure breaks above the last lower-high", () => {
    const list: Quad[] = [
      ...flat(60),
      [105, 110, 104, 105],                 // swing high1 @60 = 110
      [104, 105, 98, 99],
      [98, 99, 95.5, 96],
      [95.5, 96, 95, 95.5],                 // swing low1 @63 = 95
      [96, 98, 95.5, 97],
      [98, 101, 97.5, 100],
      [101, 103, 100.5, 102],
      [102, 106, 101.5, 103],               // swing high2 @67 = 106 (LH)
      [102, 103, 96, 97],
      [96, 97, 93.5, 94],
      [94, 95, 93, 93.5],                   // swing low2 @70 = 93 (LL)
      [94, 99, 93.5, 97],
      [98, 102, 97, 100],
      [101, 104, 100, 102.5],
      [103, 107, 102.5, 106.5],             // close above LH → character change
    ];
    expect(sigAt("CHOCH", list)).toBe("BUY");
  });

  it("TREND_PULLBACK fires BUY on a bullish touch of the rising EMA", () => {
    const list = rise(90, 0.05);
    // dip candle placed just below the real EMA50 at the last index
    const closes = [...list.map((q) => q[3]), 104.4];
    const e = ema(closes, 50).at(-1)!;
    list.push([e + 0.9, e + 1.4, e - 0.05, 104.4]); // low dips under EMA, bullish close above
    expect(sigAt("TREND_PULLBACK", list)).toBe("BUY");
  });

  it("TRENDLINE_BOUNCE fires BUY when price bounces off the rising low-line", () => {
    const list: Quad[] = [
      ...flat(60),
      [99.9, 100.5, 95, 100],               // swing low1 @60 = 95
      [100, 101, 98, 100.5],
      [100.5, 101.5, 99, 101],
      [101, 102, 100.5, 101.5],
      [101.5, 104, 101, 103],
      [103, 103.5, 100, 100.5],
      [100.5, 101, 98, 98.5],
      [98.5, 99, 96.5, 97],
      [97, 98, 95.8, 96.8],                 // swing low2 @68 = 95.8 (rising)
      [97, 99, 96.2, 98.5],
      [98.5, 101, 98, 100],
      [100, 103, 99.5, 102],
      [98, 100, 95.5, 98.5],                // touches line (≈96.2), bullish close above
    ];
    expect(sigAt("TRENDLINE_BOUNCE", list)).toBe("BUY");
  });
});

describe("zones & liquidity", () => {
  it("ORDER_BLOCK fires BUY when price returns to the bullish OB", () => {
    const list: Quad[] = [
      ...flat(60),
      [100.1, 100.3, 99.5, 99.6],           // last bearish candle = OB zone [99.5,100.3]
      [99.6, 105, 99.4, 104.9],             // impulse up (≫ 1.5×ATR)
      [104, 104.5, 102, 102.5],
      [102.5, 103, 101, 101.5],
      [101.5, 101.8, 100.5, 101],
      [100, 101.5, 99.8, 100.8],            // return into zone, bullish close above floor
    ];
    expect(sigAt("ORDER_BLOCK", list)).toBe("BUY");
  });

  it("FVG fires BUY when price retraces into an unfilled bullish gap", () => {
    const list: Quad[] = [
      ...flat(60),
      [100, 100.5, 99.5, 100.2],            // gap base — high 100.5
      [100.3, 102, 100.2, 101.8],
      [101.8, 102.5, 101.4, 102.2],         // low 101.4 > 100.5 → FVG [100.5,101.4]
      [101.6, 102.2, 101.2, 101.9],         // retraces into gap, bullish hold above floor
    ];
    expect(sigAt("FVG", list)).toBe("BUY");
  });

  it("LIQUIDITY_SWEEP fires SELL when a high is swept then rejected", () => {
    const list: Quad[] = [
      ...flat(60),
      [99.9, 105, 99.8, 100.1],             // swing high @60 = 105
      [100, 102, 99.5, 100.2],
      [100.2, 102, 99.6, 100.1],
      [100.1, 102, 99.7, 100.2],
      [104.5, 106, 103.5, 104],             // sweeps 105, closes back below
    ];
    expect(sigAt("LIQUIDITY_SWEEP", list)).toBe("SELL");
  });

  it("LIQUIDITY_SWEEP fires BUY when a low is swept then recovered", () => {
    const list: Quad[] = [
      ...flat(60),
      [100.1, 100.4, 95, 99.9],             // swing low @60 = 95
      [99.5, 100.5, 98, 100],
      [100, 100.6, 98.5, 100.2],
      [100.2, 100.5, 98.8, 100.1],
      [96.5, 97, 94, 96],                   // sweeps 95, closes back above
    ];
    expect(sigAt("LIQUIDITY_SWEEP", list)).toBe("BUY");
  });

  it("SR_BOUNCE fires BUY on a bullish rejection at support", () => {
    const list: Quad[] = [
      ...flat(60),
      [100.1, 100.4, 95, 99.9],             // support swing low = 95
      [99.5, 100.5, 98, 100],
      [100, 100.6, 98.5, 100.2],
      [100.2, 100.5, 98.8, 100.1],
      [96, 97, 95.1, 96.5],                 // tags 95+tol, bullish close above
    ];
    expect(sigAt("SR_BOUNCE", list)).toBe("BUY");
  });
});

describe("classic combos", () => {
  it("BREAKOUT_RETEST fires BUY on the retest of the broken level", () => {
    const list: Quad[] = [
      ...flat(60),                          // prior high ≈ 100.1
      [100.1, 103, 100, 102.5],             // breakout close > 100.1
      [102.5, 103.5, 101.5, 102],
      [102, 102.5, 100.8, 101.5],
      [101.5, 102, 100.9, 101.3],
      [100.9, 102, 100.2, 101],             // retest — bullish tag of level+tol, closes above
    ];
    expect(sigAt("BREAKOUT_RETEST", list)).toBe("BUY");
  });

  it("RANGE_REVERSION buys the bottom of a flat range and sells the top", () => {
    const range: Quad[] = Array.from({ length: 61 }, (_, i) =>
      i % 2 === 0 ? [99, 102, 98.5, 101] : [101, 101.5, 98.5, 99]);
    expect(sigAt("RANGE_REVERSION", [...range, [98.8, 99.3, 98.6, 99]])).toBe("BUY");
    expect(sigAt("RANGE_REVERSION", [...range, [101.8, 102, 101.5, 101.7]])).toBe("SELL");
    // trending market → not a range → HOLD
    expect(sigAt("RANGE_REVERSION", [...rise(62, 0.5), [105, 106, 104, 105.5]])).toBe("HOLD");
  });

  it("EMA_PULLBACK fires BUY when price dips to a rising EMA and recovers", () => {
    const list = rise(90, 0.05);
    const closes = [...list.map((q) => q[3]), 104.4];
    const e = ema(closes, 50).at(-1)!;
    list.push([e + 0.9, e + 1.4, e - 0.05, 104.4]); // low crosses under EMA, bullish close above
    expect(sigAt("EMA_PULLBACK", list)).toBe("BUY");
  });
});

describe("integration", () => {
  it("paSignal evaluates the last closed candle like liveTick", () => {
    const cs = candles([...flat(60), [99.8, 100.1, 98, 100]]);
    const r = paSignal(cfg("PIN_BAR"), cs);
    expect(r.signal).toBe("BUY");
    expect(r.label).toContain("پین‌بار");
    expect(r.score).toBeGreaterThan(0);
  });

  it("signal fns return HOLD on insufficient history and never look ahead", () => {
    for (const setup of PA_SETUPS) {
      const cs = candles(flat(10));
      expect(paSignalFn(cfg(setup), cs)(9), setup).toBe("HOLD");
      expect(paSignal(cfg(setup), cs).signal, setup).toBe("HOLD");
    }
  });
});
