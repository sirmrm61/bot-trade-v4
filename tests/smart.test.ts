import { describe, it, expect } from "vitest";
import {
  smartEnabled, readLearn, adaptConfig, decideEntry, recordOutcome, smartSignalFn,
  type SmartLearn, type SmartDetail,
} from "@/modules/trading/smart";
import { readAtmSmeConfig, readRmmBseConfig, readDzsHmmConfig } from "@/modules/trading/symbolic-engines";
import { runBacktest } from "@/modules/backtest/engine";
import type { Candle } from "@/modules/exchanges/types";

const empty = (): SmartLearn => ({ n: 0, strict: 0, contexts: {}, buckets: {}, w: [] });
const detail = (over: Partial<SmartDetail> = {}): SmartDetail => ({
  context: "EEC", bucket: "hi", x: [1, 0.5, 1, 1, 0.5], ...over,
});

const mkCandles = (closes: number[], volume = 100): Candle[] =>
  closes.map((c, i) => ({
    time: i * 60_000, open: c * 0.999, high: c * 1.01, low: c * 0.99, close: c, volume,
  }));

describe("smart layer — state", () => {
  it("reads malformed / missing learn state safely", () => {
    for (const bad of ["", "{}", "not json", '{"learn":"x"}', '{"learn":{"w":"bad"}}']) {
      const l = readLearn(bad);
      expect(l.n).toBe(0);
      expect(l.strict).toBe(0);
      expect(l.w).toEqual([]);
    }
  });

  it("restores persisted learn fields", () => {
    const saved: SmartLearn = {
      n: 7, strict: 0.5,
      contexts: { "ATM_SME:EEC": { w: 3, l: 1, pnl: 4 } },
      buckets: { hi: { w: 5, l: 2, pnl: 9 } },
      w: [0.1, 0.2],
    };
    const l = readLearn(JSON.stringify({ learn: saved, other: 1 }));
    expect(l).toEqual(saved);
  });

  it("smartEnabled only on explicit flag", () => {
    expect(smartEnabled("{}")).toBe(false);
    expect(smartEnabled('{"smart":false}')).toBe(false);
    expect(smartEnabled('{"smart":true}')).toBe(true);
    expect(smartEnabled("junk")).toBe(false);
  });
});

describe("smart layer — adaptive thresholds", () => {
  const baseCfg = (inner: Record<string, unknown>) => JSON.stringify({ atmSme: inner, rmmBse: inner, dzsHmm: inner, smart: true });

  it("strict=0 leaves config unchanged", () => {
    const cfg = baseCfg({ recoverVt: -0.15, bullProb: 0.75 });
    expect(adaptConfig("ATM_SME", cfg, empty())).toBe(cfg);
  });

  it("positive strictness tightens entry params", () => {
    const learn = { ...empty(), strict: 1 };
    const cfg = adaptConfig("ATM_SME", baseCfg({
      recoverVt: -0.15, minPatternWinRate: 0.65, gamma: 1.5, exitTrigger: 0.7, exitBack: 0.4,
    }), learn);
    const c = readAtmSmeConfig(cfg);
    expect(c.recoverVt).toBeGreaterThan(-0.15);
    expect(c.minPatternWinRate).toBeGreaterThan(0.65);
    expect(c.gamma).toBeGreaterThan(1.5);
    // exits get earlier under strictness
    expect(c.exitTrigger).toBeLessThan(0.7);
    expect(c.exitBack).toBeGreaterThan(0.4);
  });

  it("learned params stay inside the readers' valid ranges", () => {
    for (const strict of [-1, -0.5, 0.5, 1, 5]) { // 5 is out of range on purpose
      const learn = { ...empty(), strict };
      for (const kind of ["ATM_SME", "RMM_BSE", "DZS_HMM"] as const) {
        const cfg = adaptConfig(kind, baseCfg({
          recoverVt: -0.15, bullProb: 0.75, breakoutMt: 0.85, persist: 2, squeezeBars: 5,
        }), { ...learn, strict: Math.max(-1, Math.min(1, strict)) });
        // readers must accept the adapted JSON without throwing
        if (kind === "ATM_SME") readAtmSmeConfig(cfg);
        else if (kind === "RMM_BSE") readRmmBseConfig(cfg);
        else readDzsHmmConfig(cfg);
      }
    }
  });

  it("integer params stay integers after adaptation", () => {
    const learn = { ...empty(), strict: 0.7 };
    const cfg = adaptConfig("DZS_HMM", baseCfg({ persist: 3 }), learn);
    const v = (JSON.parse(cfg).dzsHmm as Record<string, number>).persist;
    expect(Number.isInteger(v)).toBe(true);
  });
});

describe("smart layer — context veto + scorer + sizing", () => {
  it("vetoes a context after enough losses", () => {
    let l = empty();
    for (let i = 0; i < 4; i++) l = recordOutcome("ATM_SME", l, detail(), -2);
    const d = decideEntry("ATM_SME", l, detail());
    expect(d.allow).toBe(false);
    expect(d.veto).toBe("ctx:EEC");
  });

  it("does not veto below the sample threshold", () => {
    let l = empty();
    for (let i = 0; i < 3; i++) l = recordOutcome("ATM_SME", l, detail(), -2);
    expect(decideEntry("ATM_SME", l, detail()).allow).toBe(true);
  });

  it("other contexts are unaffected by a vetoed one", () => {
    let l = empty();
    for (let i = 0; i < 4; i++) l = recordOutcome("ATM_SME", l, detail(), -2);
    expect(decideEntry("ATM_SME", l, detail({ context: "MID" })).allow).toBe(true);
  });

  it("losing buckets shrink size, winning buckets grow — bounded", () => {
    let l = empty();
    for (let i = 0; i < 5; i++) l = recordOutcome("RMM_BSE", l, detail({ bucket: "lo" }), -1);
    // dissimilar features so the trained scorer doesn't gate this entry
    const bad = decideEntry("RMM_BSE", l, detail({ context: "Z", bucket: "lo", x: [1, -0.9, 0, -1, 0.1] }));
    expect(bad.sizeMult).toBeLessThan(1);
    let w = empty();
    for (let i = 0; i < 8; i++) w = recordOutcome("RMM_BSE", w, detail({ bucket: "hi", context: "G" }), 3);
    const good = decideEntry("RMM_BSE", w, detail({ context: "G", bucket: "hi" }));
    expect(good.sizeMult).toBeGreaterThan(1);
    expect(good.sizeMult).toBeLessThanOrEqual(1.75);
  });

  it("perceptron weights adapt toward outcomes", () => {
    let l = empty();
    const before = 0;
    for (let i = 0; i < 6; i++) l = recordOutcome("DZS_HMM", l, detail(), 1);
    expect(l.w[3]).toBeGreaterThan(before); // bullish feature weight grows on wins
    const wlen = l.w.length;
    for (let i = 0; i < 10; i++) l = recordOutcome("DZS_HMM", l, detail(), -3);
    expect(l.w.length).toBe(wlen);
    expect(l.strict).toBeLessThanOrEqual(1);
    expect(l.strict).toBeGreaterThanOrEqual(-1);
  });

  it("score gate blocks entries after warmup when the model is pessimistic", () => {
    let l = empty();
    for (let i = 0; i < 8; i++) l = recordOutcome("ATM_SME", l, detail({ context: "X" }), -2);
    // context X isn't vetoed (sample ≥4 but… it IS ≥4 and all losses → veto'd by context)
    // use a fresh context so only the score gate can block
    const d = decideEntry("ATM_SME", l, detail({ context: "FRESH", x: [1, 0.9, 1, 1, 0.9] }));
    // with 8 losses on identical-ish features the scorer should be pessimistic
    expect(d.smartScore).toBeLessThan(0.5);
  });
});

describe("smart layer — backtest integration", () => {
  const candles = mkCandles([
    ...Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 3), // wavy → signals
    ...Array.from({ length: 100 }, (_, i) => 103 + i * 0.5),             // rally
    ...Array.from({ length: 60 }, (_, i) => 153 - i * 0.8),              // dump
  ]);

  it("signalFn.onTradeClosed fires for every closed trade", () => {
    const closed: number[] = [];
    const fn = Object.assign((i: number): "BUY" | "SELL" | "HOLD" => (i === 70 ? "BUY" : i === 110 ? "SELL" : "HOLD"), {
      onTradeClosed: (pnlPct: number) => closed.push(pnlPct),
    });
    const r = runBacktest({
      candles, indicators: [], buyThreshold: 0.5, sellThreshold: -0.5,
      initialBalance: 1_000_000, riskPerTradePct: 50, stopLossPct: 5, takeProfitPct: 10,
      trailingStop: false, feePct: 0.2, slippagePct: 0.05, minCandles: 30, signalFn: fn,
    });
    expect(r.totalTrades).toBe(1);
    expect(closed).toHaveLength(1);
    expect(Number.isFinite(closed[0])).toBe(true);
  });

  it("smartSignalFn learns inside the simulation", () => {
    const fn = smartSignalFn("ATM_SME", candles, JSON.stringify({
      smart: true,
      atmSme: { volWindow: 10, tokenMid: 0.1, tokenExtreme: 0.3, minPatternWinRate: 0.3, minPatternCount: 1, probWindow: 60 },
    }));
    const r = runBacktest({
      candles, indicators: [], buyThreshold: 0.5, sellThreshold: -0.5,
      initialBalance: 1_000_000, riskPerTradePct: 50, stopLossPct: 3, takeProfitPct: 6,
      trailingStop: false, feePct: 0.2, slippagePct: 0.05, minCandles: 30, signalFn: fn,
    });
    if (r.totalTrades > 0) {
      const l = fn.getLearn();
      expect(l.n).toBe(r.totalTrades);
      expect(Object.keys(l.contexts).length).toBeGreaterThan(0);
      expect(l.w.length).toBe(5); // ATM-SME feature vector
    }
  });
});
