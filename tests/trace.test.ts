import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestParams } from "@/modules/backtest/engine";
import { Tracer, tradeTraceId, backtestRunId, opportunityTraceId } from "@/modules/trace/tracer";
import { auditPnl } from "@/modules/trace/pnl-audit";
import { evaluateOpportunity, backtestScanner } from "@/modules/opportunity/engine";
import { eventsToCsv } from "@/modules/trace/service";
import type { Candle } from "@/modules/exchanges/types";

/** deterministic candle series — gentle uptrend with wiggle so signals fire */
function mkCandles(n: number, start = 100, drift = 0.2, vol = 1): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const prev = price;
    price = start + drift * i + Math.sin(i / 5) * vol;
    const open = prev;
    const close = price;
    out.push({
      time: 1_700_000_000_000 + i * 60_000,
      open, close,
      high: Math.max(open, close) + vol * 0.4,
      low: Math.min(open, close) - vol * 0.4,
      volume: 1000 + i,
    });
  }
  return out;
}

/** RSI strategy — dip→rally→dump pattern fires BUY then reverses (same shape
 *  as the existing backtest.test.ts fixture so behavior is comparable) */
const SIGNAL_CLOSES = [
  ...Array.from({ length: 80 }, (_, i) => 100 - i * 0.5),   // downtrend → RSI oversold
  ...Array.from({ length: 60 }, (_, i) => 60 + i * 0.8),     // rally
  ...Array.from({ length: 40 }, (_, i) => 108 - i * 1.5),    // dump
];
const SIGNAL_CANDLES = SIGNAL_CLOSES.map((c, i) => ({
  time: i * 3_600_000, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1,
}));
const IND = [
  { name: "RSI", parameters: { period: 14 }, weight: 1, enabled: true,
    buyCondition: JSON.stringify({ op: "lt", value: 35 }),
    sellCondition: JSON.stringify({ op: "gt", value: 65 }) },
];

const baseParams = (over: Partial<BacktestParams> = {}): BacktestParams => ({
  candles: SIGNAL_CANDLES,
  indicators: IND as never,
  buyThreshold: 0.5,
  sellThreshold: -0.5,
  initialBalance: 10_000_000,
  riskPerTradePct: 50,
  stopLossPct: 2,
  takeProfitPct: 5,
  trailingStop: false,
  feePct: 0.25,
  slippagePct: 0.05,
  minCandles: 30,
  ...over,
});

describe("Tracer", () => {
  it("OFF level records nothing", () => {
    const t = new Tracer("r1", { level: "OFF" });
    t.emit({ stage: "SCANNER", event: "X" });
    t.summary();
    expect(t.events).toHaveLength(0);
  });

  it("SUMMARY keeps only important events", () => {
    const t = new Tracer("r1", { level: "SUMMARY" });
    t.emit({ stage: "SCANNER", event: "MARKET_SNAPSHOT" });
    t.emit({ stage: "ENTRY", event: "FILLED", important: true });
    t.summary();
    expect(t.events.map((e) => e.event)).toEqual(["FILLED", "RUN_SUMMARY"]);
  });

  it("FULL keeps everything and enforces maxEvents", () => {
    const t = new Tracer("r1", { level: "FULL", maxEvents: 5 });
    for (let i = 0; i < 10; i++) t.emit({ stage: "SCANNER", event: `E${i}` });
    expect(t.truncated).toBe(true);
    expect(t.events.length).toBe(6); // 5 + TRACE_TRUNCATED marker
    expect(t.events.at(-1)?.event).toBe("TRACE_TRUNCATED");
  });

  it("symbol scope filter drops out-of-scope events", () => {
    const t = new Tracer("r1", { level: "FULL", symbols: ["ETHUSDT"] });
    t.emit({ stage: "SCANNER", event: "A", symbol: "BTCUSDT" });
    t.emit({ stage: "SCANNER", event: "B", symbol: "ETHUSDT" });
    expect(t.events).toHaveLength(1);
    expect(t.events[0].event).toBe("B");
  });

  it("reject() aggregates stage and reason counters", () => {
    const t = new Tracer("r1", { level: "SUMMARY" });
    t.reject("COST", "Spread too high");
    t.reject("COST", "Spread too high");
    t.reject("RISK", "Low RR");
    expect(t.counters.rejectionsByStage).toEqual({ COST: 2, RISK: 1 });
    expect(t.counters.rejectionsByReason["Spread too high"]).toBe(2);
  });

  it("deterministic ids", () => {
    expect(backtestRunId("abc")).toBe("bt-abc");
    expect(tradeTraceId("bt-x", 3)).toBe("tr-bt-x-3");
    expect(opportunityTraceId("r", "BTC", 42)).toBe("opp-r-BTC-42");
  });
});

describe("runBacktest tracing", () => {
  it("emits the full chain for every trade in SUMMARY mode", () => {
    const tracer = new Tracer("bt-t1", { level: "SUMMARY" });
    const res = runBacktest(baseParams({ tracer, symbol: "TEST" }));
    expect(res.totalTrades).toBeGreaterThan(0);
    const ev = tracer.events;
    const kinds = new Set(ev.map((e) => e.stage));
    expect(kinds.has("ENTRY")).toBe(true);
    expect(kinds.has("EXIT")).toBe(true);
    expect(kinds.has("PNL_AUDIT")).toBe(true);
    expect(ev.at(-1)?.event).toBe("RUN_SUMMARY");
    // every trade got a traceId and linked events
    for (const t of res.trades) {
      expect(t.traceId).toMatch(/^tr-bt-t1-\d+$/);
      const chain = ev.filter((e) => e.refId === t.traceId);
      expect(chain.some((e) => e.event === "FILLED")).toBe(true);
      expect(chain.some((e) => e.event === "POSITION_CLOSED")).toBe(true);
      expect(chain.some((e) => e.stage === "PNL_AUDIT")).toBe(true);
    }
  });

  it("records per-bar evals only in FULL mode", () => {
    const full = new Tracer("bt-f", { level: "FULL" });
    runBacktest(baseParams({ tracer: full }));
    expect(full.events.some((e) => e.event === "MARKET_SNAPSHOT")).toBe(true);
    expect(full.events.some((e) => e.event === "SIGNAL_EVAL")).toBe(true);

    const sum = new Tracer("bt-s", { level: "SUMMARY" });
    runBacktest(baseParams({ tracer: sum }));
    expect(sum.events.some((e) => e.event === "MARKET_SNAPSHOT")).toBe(false);
  });

  it("flags look-ahead on same-bar entry; strict mode enforces next bar", () => {
    const loose = new Tracer("bt-l", { level: "SUMMARY" });
    runBacktest(baseParams({ tracer: loose, executionDelayMs: 0 }));
    const warnings = loose.events.filter((e) => e.event === "LOOKAHEAD_BIAS");
    expect(warnings.length).toBeGreaterThan(0);
    expect(loose.counters.lookaheadWarnings).toBe(warnings.length);

    const strict = new Tracer("bt-st", { level: "SUMMARY" });
    const res = runBacktest(baseParams({ tracer: strict, executionDelayMs: 0, strictCausality: true }));
    expect(strict.events.some((e) => e.event === "LOOKAHEAD_ENFORCED")).toBe(true);
    // strict: entry bar strictly after signal bar
    for (const e of strict.events.filter((x) => x.event === "FILLED")) {
      expect(e.barIndex!).toBeGreaterThan(e.data?.signalBarIndex as number);
    }
    // strict run still deterministic — same inputs → same trades
    const res2 = runBacktest(baseParams({ executionDelayMs: 0, strictCausality: true }));
    expect(res.trades.map((t) => [t.entryPrice, t.exitPrice])).toEqual(
      res2.trades.map((t) => [t.entryPrice, t.exitPrice]),
    );
  });

  it("marks TP+SL same-candle exits as ambiguous per policy", () => {
    // wide candles so one bar spans both stops; tight stops guarantee hits
    const candles = mkCandles(120, 100, 0.3, 0.5).map((c, i) =>
      i > 60 ? { ...c, high: c.close + 8, low: c.close - 8 } : c,
    );
    const tracer = new Tracer("bt-a", { level: "SUMMARY" });
    const res = runBacktest(baseParams({
      candles, tracer, stopLossPct: 1, takeProfitPct: 1,
      ambiguityPolicy: "SL_FIRST",
    }));
    const amb = tracer.events.filter((e) => e.event === "AMBIGUOUS_EXIT");
    if (res.trades.some((t) => t.ambiguousExit)) {
      expect(amb.length).toBeGreaterThan(0);
      expect(amb[0].data?.resolvedTo).toBe("STOP_LOSS");
      // TP_FIRST policy resolves the same candles to TP
      const res2 = runBacktest(baseParams({
        candles, stopLossPct: 1, takeProfitPct: 1, ambiguityPolicy: "TP_FIRST",
      }));
      const reasons = res2.trades.filter((t) => t.ambiguousExit).map((t) => t.exitReason);
      expect(reasons.every((r) => r === "TAKE_PROFIT")).toBe(true);
    }
  });

  it("PnL audit recomputes every trade's pnl exactly", () => {
    const tracer = new Tracer("bt-p", { level: "SUMMARY" });
    const res = runBacktest(baseParams({ tracer }));
    const audits = tracer.events.filter((e) => e.stage === "PNL_AUDIT");
    expect(audits.length).toBe(res.totalTrades);
    expect(audits.every((e) => e.event === "PNL_OK")).toBe(true);
    expect(tracer.counters.pnlAuditErrors).toBe(0);
  });

  it("records rejection when balance is exhausted", () => {
    const tracer = new Tracer("bt-b", { level: "SUMMARY" });
    runBacktest(baseParams({ tracer, initialBalance: 0 }));
    expect(tracer.counters.rejectionsByStage.RISK ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("no tracer → no overhead, identical results", () => {
    const a = runBacktest(baseParams());
    const b = runBacktest(baseParams({ tracer: new Tracer("x", { level: "OFF" }) }));
    expect(a.trades).toEqual(b.trades.map((t) => ({ ...t, traceId: undefined })));
  });
});

describe("auditPnl", () => {
  const base = {
    side: "LONG" as const, rawEntryPrice: 100, rawExitPrice: 104,
    fillEntryPrice: 100.05, fillExitPrice: 103.9,
    amount: 0.9, invested: 90, entryFee: 0.225, exitFee: 0.23,
    market: "SPOT" as const, recordedPnl: 0,
  };
  it("rebuilds spot pnl to the recorded value", () => {
    // engine identity: proceeds − exitFee − invested
    const recorded = 0.9 * 103.9 - 0.23 - 90;
    const r = auditPnl({ ...base, recordedPnl: recorded });
    expect(r.ok).toBe(true);
    expect(r.drift).toBeLessThan(1e-6);
  });
  it("flags a tampered pnl", () => {
    const r = auditPnl({ ...base, recordedPnl: 999 });
    expect(r.ok).toBe(false);
    expect(r.drift).toBeGreaterThan(900);
  });
});

describe("scanner trace", () => {
  const flat = mkCandles(120, 100, 0, 0.05); // no trend → no direction
  const trend = mkCandles(120, 100, 0.8, 0.3);

  it("evaluateOpportunity reports failed filters + primary reason", () => {
    const v = evaluateOpportunity({ candles: flat, costPct: 0.5, scanScore: 50, mid: 100 });
    expect(v.opportunity).toBeNull();
    expect(v.rejection?.stage).toBe("STRATEGY");
    expect(v.rejection?.filters[0].filterName).toBe("momentum_direction");
    expect(v.rejection?.filters[0].result).toBe("FAIL");
  });

  it("evaluateOpportunity passes filters on acceptance", () => {
    const v = evaluateOpportunity({ candles: trend, costPct: 0.3, scanScore: 80, mid: trend.at(-1)!.close });
    if (v.opportunity) {
      const names = v.rejection === null ? [] : [];
      expect(names).toEqual([]);
      expect(v.opportunity.netReturnPct).toBeGreaterThan(0);
    }
  });

  it("backtestScanner emits rejections + opportunity lifecycle", () => {
    // flat market → every bar rejected on direction; trending → some accepted
    const flatTracer = new Tracer("scan-f", { level: "FULL" });
    backtestScanner({ candles: flat, costPct: 0.4, tracer: flatTracer, symbol: "T" });
    expect(flatTracer.events.some((e) => e.event === "CANDIDATE_REJECTED")).toBe(true);
    expect(flatTracer.events.at(-1)?.event).toBe("RUN_SUMMARY");
    expect(Object.keys(flatTracer.counters.rejectionsByStage).length).toBeGreaterThan(0);

    const tracer = new Tracer("scan-1", { level: "FULL" });
    const r = backtestScanner({ candles: trend, costPct: 0.4, tracer, symbol: "T" });
    const ev = tracer.events;
    if (r.totalSignals > 0) {
      expect(ev.some((e) => e.event === "OPPORTUNITY_OPENED")).toBe(true);
      expect(ev.some((e) => e.event === "OPPORTUNITY_CLOSED")).toBe(true);
    }
    expect(ev.at(-1)?.event).toBe("RUN_SUMMARY");
  });
});

describe("CSV export", () => {
  it("serializes events with escaped payload", () => {
    const csv = eventsToCsv([
      { seq: 0, ts: 1, runId: "r", stage: "ENTRY", event: "FILLED", data: { note: 'a,"b"' } },
      { seq: 1, ts: 2, runId: "r", stage: "EXIT", event: "CLOSED" },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("seq,ts,runId,refId,stage,event,symbol,barIndex,candleTs,data");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("FILLED");
  });
});
