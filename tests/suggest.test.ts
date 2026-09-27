import { describe, it, expect } from "vitest";
import { marketStats, suggestParams } from "@/modules/strategies/suggest";
import type { Candle } from "@/modules/exchanges/types";

function candles(n: number, opts: { vol?: number; trend?: number } = {}): Candle[] {
  const { vol = 0.01, trend = 0 } = opts;
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + trend / n + vol * Math.sin(i * 1.7);
    return { time: i * 60_000, open: p, high: p * (1 + vol), low: p * (1 - vol), close: p, volume: 100 };
  });
}

const stats = marketStats(candles(400));

describe("marketStats", () => {
  it("computes volatility and trend", () => {
    const s = marketStats(candles(400, { vol: 0.02, trend: 30 }));
    expect(s.volPct).toBeGreaterThan(0.5);
    expect(s.trendPct).toBeGreaterThan(20);
    expect(s.atrPct).toBeGreaterThan(0);
    expect(s.regime).toBe("trending");
  });
  it("detects ranging market", () => {
    const s = marketStats(candles(400, { vol: 0.004 }));
    expect(s.regime).toBe("ranging");
  });
});

describe("suggestParams", () => {
  for (const kind of ["ATM_SME", "RMM_BSE", "DZS_HMM"] as const) {
    for (const risk of ["LOW", "MEDIUM", "HIGH"] as const) {
      it(`${kind} × ${risk} → valid field set`, () => {
        const { fields, notes } = suggestParams(kind, risk, stats);
        expect(notes.length).toBeGreaterThan(0);
        // shared risk fields always present
        for (const k of ["riskPerTradePct", "stopLossPct", "takeProfitPct"]) {
          expect(typeof fields[k]).toBe("number");
          expect(fields[k] as number).toBeGreaterThan(0);
        }
      });
    }
  }

  it("risk ordering: LOW tighter risk, HIGH looser", () => {
    for (const kind of ["ATM_SME", "RMM_BSE", "DZS_HMM"] as const) {
      const lo = suggestParams(kind, "LOW", stats).fields;
      const hi = suggestParams(kind, "HIGH", stats).fields;
      expect(lo.riskPerTradePct).toBeLessThan(hi.riskPerTradePct as number);
      expect(lo.maxPositionPct).toBeLessThan(hi.maxPositionPct as number);
    }
  });

  it("caps probWindow to available history", () => {
    const few = marketStats(candles(120));
    const { fields } = suggestParams("ATM_SME", "MEDIUM", few);
    expect(fields.probWindow).toBeLessThanOrEqual(72);
    expect(fields.probWindow).toBeGreaterThanOrEqual(30);
  });

  it("futures leverage suggestion follows risk", () => {
    expect(suggestParams("ATM_SME", "LOW", stats).fields.leverage).toBe(2);
    expect(suggestParams("ATM_SME", "HIGH", stats).fields.leverage).toBe(5);
  });

  it("OBI mirrors thresholds by risk", () => {
    const f = suggestParams("ORDER_BOOK_IMBALANCE", "MEDIUM", stats).fields;
    expect(f.buyThreshold).toBeCloseTo(0.2);
    expect(f.sellThreshold).toBeCloseTo(-0.2);
  });
});
