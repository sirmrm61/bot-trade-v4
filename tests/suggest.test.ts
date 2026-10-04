import { describe, it, expect } from "vitest";
import { marketStats, suggestParams, type RiskLevel } from "@/modules/strategies/suggest";
import { validateStrategyInput, type StrategyInput } from "@/modules/strategies/service";
import { readAtmSmeConfig, readRmmBseConfig, readDzsHmmConfig } from "@/modules/trading/symbolic-engines";
import { readMmConfig } from "@/modules/trading/market-making";
import type { Candle } from "@/modules/exchanges/types";

function candles(n: number, opts: { vol?: number; trend?: number } = {}): Candle[] {
  const { vol = 0.01, trend = 0 } = opts;
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= 1 + trend / n + vol * Math.sin(i * 1.7);
    return { time: i * 60_000, open: p, high: p * (1 + vol), low: p * (1 - vol), close: p, volume: 100 };
  });
}

/** min/max of every numeric input in builder.tsx — mirror of the form's HTML5 constraints */
const FIELD_LIMITS: Record<string, { min: number; max: number; int?: boolean }> = {
  // shared risk
  riskPerTradePct: { min: 0, max: 100 },
  maxPositionPct: { min: 1, max: 100, int: true },
  stopLossPct: { min: 0, max: 100 },
  takeProfitPct: { min: 0, max: 100 },
  trailingStopPct: { min: 0, max: 100 },
  leverage: { min: 1, max: 10 },
  buyThreshold: { min: -1, max: 1 },
  sellThreshold: { min: -1, max: 1 },
  // ATM_SME
  volWindow: { min: 2, max: 500, int: true },
  gamma: { min: 0.01, max: 100 },
  tokenMid: { min: 0.01, max: 0.99 },
  tokenExtreme: { min: 0.01, max: 1 },
  emaPeriod: { min: 1, max: 200, int: true },
  recoverVt: { min: -1, max: 1 },
  weakenVt: { min: -1, max: 1 },
  minPatternWinRate: { min: 0, max: 1 },
  minPatternCount: { min: 0, max: 100, int: true },
  probWindow: { min: 10, max: 5000, int: true },
  exitTrigger: { min: -1, max: 1 },
  exitBack: { min: -1, max: 1 },
  decayLookback: { min: 1, max: 200, int: true },
  // RMM_BSE
  channelLen: { min: 2, max: 500, int: true },
  squeezeAbs: { min: 0.01, max: 1 },
  squeezeBars: { min: 1, max: 100, int: true },
  breakoutMt: { min: 0.01, max: 1 },
  exitMt: { min: -1, max: 1 },
  volMult: { min: 0.1, max: 100 },
  volPeriod: { min: 1, max: 500, int: true },
  // DZS_HMM
  zWindow: { min: 5, max: 1000, int: true },
  emitCenter: { min: 0.05, max: 1 },
  emitSigma: { min: 0.01, max: 2 },
  pStay: { min: 0.5, max: 0.99 },
  bullProb: { min: 0.5, max: 0.99 },
  sCross: { min: 0.01, max: 1 },
  persist: { min: 1, max: 20, int: true },
  rangeProbExit: { min: 0.1, max: 0.99 },
  bearProbExit: { min: 0.1, max: 0.99 },
  // OBI
  depthLevels: { min: 1, max: 50, int: true },
  hysteresis: { min: 0, max: 50, int: true },
  // MARKET_MAKING
  spreadPct: { min: 0.01, max: 10 },
  orderSizePct: { min: 0.1, max: 100 },
  levels: { min: 1, max: 10, int: true },
  levelStepPct: { min: 0, max: 10 },
  requotePct: { min: 0, max: 10 },
  maxInventoryPct: { min: 1, max: 100 },
};

const RISKS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH"];
const KINDS = ["ATM_SME", "RMM_BSE", "DZS_HMM", "ORDER_BOOK_IMBALANCE", "MARKET_MAKING"] as const;
const PICK: Record<string, string[]> = {
  ATM_SME: ["volWindow", "gamma", "tokenMid", "tokenExtreme", "emaPeriod", "useEmaConfirm", "recoverVt", "weakenVt", "minPatternWinRate", "minPatternCount", "probWindow", "exitTrigger", "exitBack", "decayLookback"],
  RMM_BSE: ["channelLen", "squeezeAbs", "squeezeBars", "breakoutMt", "exitMt", "useVolumeConfirm", "volMult", "volPeriod"],
  DZS_HMM: ["zWindow", "dzsFeature", "emitCenter", "emitSigma", "pStay", "bullProb", "sCross", "persist", "rangeProbExit", "bearProbExit"],
  ORDER_BOOK_IMBALANCE: ["depthLevels", "emaPeriod", "hysteresis", "buyThreshold", "sellThreshold"],
  MARKET_MAKING: ["spreadPct", "orderSizePct", "levels", "levelStepPct", "requotePct", "maxInventoryPct"],
};

/** assemble the same StrategyInput the builder would POST after fields are applied */
function payloadFor(kind: string, fields: Record<string, number | string | boolean>): StrategyInput {
  const pick = (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k === "dzsFeature" ? "feature" : k, fields[k]]).filter(([, v]) => v !== undefined));
  const base: StrategyInput = {
    name: "t", symbol: "BTCIRT", timeframe: "1h",
    kind: kind as never,
    buyThreshold: Number(fields.buyThreshold ?? 0.35),
    sellThreshold: Number(fields.sellThreshold ?? -0.35),
    riskPerTradePct: Number(fields.riskPerTradePct ?? 1),
    stopLossPct: Number(fields.stopLossPct ?? 1),
    takeProfitPct: Number(fields.takeProfitPct ?? 2),
    trailingStop: Boolean(fields.trailingStop),
    trailingStopPct: fields.trailingStopPct === undefined ? null : Number(fields.trailingStopPct),
    maxPositionPct: Number(fields.maxPositionPct ?? 100),
    orderType: kind === "MARKET_MAKING" ? "LIMIT" : "MARKET",
    market: "SPOT",
    indicators: [],
  };
  if (kind === "ATM_SME") base.atmSme = pick(PICK.ATM_SME);
  if (kind === "RMM_BSE") base.rmmBse = pick(PICK.RMM_BSE);
  if (kind === "DZS_HMM") base.dzsHmm = pick(PICK.DZS_HMM);
  if (kind === "ORDER_BOOK_IMBALANCE") base.orderBookImbalance = pick(PICK.ORDER_BOOK_IMBALANCE);
  if (kind === "MARKET_MAKING") base.marketMaking = pick(PICK.MARKET_MAKING);
  return base;
}

const MARKETS = {
  calm: marketStats(candles(400, { vol: 0.004 })),
  normal: marketStats(candles(400, { vol: 0.01, trend: 12 })),
  volatile: marketStats(candles(400, { vol: 0.03, trend: -25 })),
  shortHistory: marketStats(candles(80, { vol: 0.01 })),
};

describe("suggest — every param within form + server constraints", () => {
  for (const [mname, stats] of Object.entries(MARKETS)) {
    for (const kind of KINDS) {
      for (const risk of RISKS) {
        it(`${kind} × ${risk} @ ${mname}`, () => {
          const { fields, notes } = suggestParams(kind, risk, stats);
          expect(notes.length).toBeGreaterThan(0);

          // every suggested field must satisfy the builder input's min/max (and int steps)
          for (const [k, v] of Object.entries(fields)) {
            if (typeof v !== "number") continue;
            const lim = FIELD_LIMITS[k];
            if (!lim) continue; // e.g. trailingStop checkbox handled separately
            expect(v, `${k}=${v} < min`).toBeGreaterThanOrEqual(lim.min);
            expect(v, `${k}=${v} > max`).toBeLessThanOrEqual(lim.max);
            if (lim.int) expect(Number.isInteger(v), `${k}=${v} not int`).toBe(true);
          }

          // the full payload must pass server-side validation
          expect(() => validateStrategyInput(payloadFor(kind, fields))).not.toThrow();

          // engine config readers must accept the suggested config JSON
          const cfg = JSON.stringify(payloadFor(kind, fields));
          if (kind === "ATM_SME") expect(() => readAtmSmeConfig(cfg)).not.toThrow();
          if (kind === "RMM_BSE") expect(() => readRmmBseConfig(cfg)).not.toThrow();
          if (kind === "DZS_HMM") expect(() => readDzsHmmConfig(cfg)).not.toThrow();
          if (kind === "MARKET_MAKING") expect(() => readMmConfig(cfg)).not.toThrow();
        });
      }
    }
  }

  it("risk ordering: LOW tighter, HIGH looser", () => {
    const s = MARKETS.normal;
    for (const kind of ["ATM_SME", "RMM_BSE", "DZS_HMM"] as const) {
      const lo = suggestParams(kind, "LOW", s).fields;
      const hi = suggestParams(kind, "HIGH", s).fields;
      expect(lo.riskPerTradePct).toBeLessThan(hi.riskPerTradePct as number);
      expect(lo.maxPositionPct).toBeLessThan(hi.maxPositionPct as number);
    }
  });

  it("symbolic engines never suggest leverage above the hard cap (2)", () => {
    for (const kind of ["ATM_SME", "RMM_BSE", "DZS_HMM"] as const) {
      for (const risk of RISKS) {
        const f = suggestParams(kind, risk, MARKETS.volatile).fields;
        expect(f.leverage).toBeLessThanOrEqual(2);
      }
    }
  });

  it("non-symbolic kinds keep the full leverage range", () => {
    const f = suggestParams("MARKET_MAKING", "HIGH", MARKETS.volatile).fields;
    expect(f.leverage).toBe(5);
  });
});
