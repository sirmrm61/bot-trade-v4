import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { atr } from "@/modules/indicators/engine";
import { parseJson } from "@/shared/utils";
import { buildDataset, btcContext, HORIZON_CONFIGS, tripleBarrierLabel, type HorizonConfig } from "./dataset";
import { trainLogReg, predictProba, serializeModel, deserializeModel, type LogRegModel } from "./model";
import { evaluate, passesHonestyGate } from "./validate";
import { precompute, featureVectorAt, FEATURE_NAMES, type FeatureContext } from "./features";

/**
 * Forecast orchestration — retrain, predict, resolve, monitor.
 *
 * Honesty contract:
 * - A model version becomes `active` ONLY when it beats the base-rate
 *   baseline out-of-sample (passesHonestyGate).
 * - Live accuracy is measured continuously from resolved predictions; two
 *   consecutive days below baseline deactivates the model.
 * - When no active model exists, the entry gate silently skips the forecast
 *   check — the system behaves exactly as before.
 */

const HORIZON_MS: Record<string, number> = {
  "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 3_600_000, "4h": 4 * 3_600_000, "12h": 12 * 3_600_000,
};

// ---------------------------------------------------------------------------
// retraining — daily job
// ---------------------------------------------------------------------------

export interface RetrainReport {
  horizon: string;
  symbol: string;
  trainAuc: number;
  testAuc: number;
  testBrier: number;
  baselineBrier: number;
  beatsBaseline: boolean;
  activated: boolean;
  reasons: string[];
  samplesTest: number;
}

export async function retrainModels(opts: {
  symbols?: string[];
  exchange?: string;
  agentId?: string;
} = {}): Promise<RetrainReport[]> {
  const exchange = opts.exchange ?? "KUCOIN";
  // default: the pairs agents actually manage — predictions where decisions happen
  let symbols = opts.symbols;
  if (!symbols?.length) {
    const agents = await prisma.tradingAgent.findMany({
      where: { exchange, status: { in: ["RUNNING", "PAUSED"] } }, select: { managed: true },
    });
    symbols = [...new Set(agents.flatMap((a) =>
      parseJson<{ symbol: string }[]>(a.managed, []).map((m) => m.symbol)))];
  }
  if (!symbols.length) return [];

  const reports: RetrainReport[] = [];
  const journal = opts.agentId
    ? async (type: "MODEL_UPDATE", summary: string, data?: unknown) => {
        const { journalWrite } = await import("@/modules/agent/journal");
        await journalWrite(opts.agentId!, type, summary, { data });
      }
    : async () => {};

  for (const cfg of HORIZON_CONFIGS) {
    const btc = await btcContext(exchange, cfg.timeframe, 75);
    for (const symbol of symbols) {
      const r = await retrainOne(exchange, symbol, cfg, btc).catch((e) => {
        logger.warn("forecast retrain failed", { module: "forecast", symbol, horizon: cfg.horizon, error: String(e).slice(0, 160) });
        return null;
      });
      if (!r) continue;
      reports.push(r);
      await journal("MODEL_UPDATE",
        r.activated
          ? `مدل ${cfg.horizon} برای ${symbol} فعال شد — AUC تست ${r.testAuc.toFixed(3)}، Brier ${r.testBrier.toFixed(4)} در برابر baseline ${r.baselineBrier.toFixed(4)}`
          : `مدل ${cfg.horizon} برای ${symbol} فعال نشد — AUC تست ${r.testAuc.toFixed(3)}: ${r.reasons.join("؛ ")}`,
        { ...r });
    }
  }
  return reports;
}

async function retrainOne(
  exchange: string, symbol: string, cfg: HorizonConfig, btc: Awaited<ReturnType<typeof btcContext>>,
): Promise<RetrainReport | null> {
  const ds = await buildDataset({ symbol, exchange, cfg, days: 60, btcCandles: btc });
  const train = ds.rows.slice(0, ds.splitIdx);
  const test = ds.rows.slice(ds.splitIdx);
  if (train.length < 300 || test.length < 80) return null;

  const model = trainLogReg(train.map((r) => r.features), train.map((r) => r.label));
  const trainM = evaluate(model, train);
  const testM = evaluate(model, test);
  const gate = passesHonestyGate(testM);

  const prev = await prisma.modelVersion.findFirst({
    where: { exchange, symbolScope: symbol, timeframe: cfg.timeframe, horizon: cfg.horizon, active: true },
  });

  // a new version replaces the active one only if it honestly beats baseline
  // AND isn't clearly worse than the incumbent on the same metric
  const beatsIncumbent = !prev || (() => {
    const pm = parseJson<{ auc?: number; brier?: number }>(prev.testMetrics, {});
    return testM.auc >= (pm.auc ?? 0) - 0.01; // allow tiny regression, not real decay
  })();
  const active = gate.pass && beatsIncumbent;

  const created = await prisma.modelVersion.create({
    data: {
      kind: "LOGREG", exchange, symbolScope: symbol,
      timeframe: cfg.timeframe, horizon: cfg.horizon, barrierK: ds.barrierK,
      featureNames: JSON.stringify(FEATURE_NAMES),
      weights: serializeModel(model),
      trainMetrics: JSON.stringify({ auc: trainM.auc, brier: trainM.brier, n: trainM.n }),
      testMetrics: JSON.stringify({
        auc: testM.auc, brier: testM.brier, brierBaseline: testM.brierBaseline,
        logLoss: testM.logLoss, baseRate: testM.baseRate,
        calibration: testM.calibration, winRateByConfidence: testM.winRateByConfidence,
      }),
      samplesTrain: trainM.n, samplesTest: testM.n,
      active, beatsBaseline: gate.pass,
      deactivatedReason: gate.pass ? null : gate.reasons.join("؛ "),
      supersedesId: prev?.id ?? null,
    },
  });
  if (active && prev) {
    await prisma.modelVersion.update({ where: { id: prev.id }, data: { active: false } });
  }
  // keep only the newest 20 versions per scope — the table stays bounded
  const olds = await prisma.modelVersion.findMany({
    where: { exchange, symbolScope: symbol, timeframe: cfg.timeframe, horizon: cfg.horizon, id: { not: created.id } },
    orderBy: { trainedAt: "desc" }, skip: 19, select: { id: true },
  });
  if (olds.length) await prisma.modelVersion.deleteMany({ where: { id: { in: olds.map((o) => o.id) } } });

  return {
    horizon: cfg.horizon, symbol,
    trainAuc: trainM.auc, testAuc: testM.auc,
    testBrier: testM.brier, baselineBrier: testM.brierBaseline,
    beatsBaseline: gate.pass, activated: active,
    reasons: gate.pass ? (beatsIncumbent ? [] : ["بدتر از نسخه‌ی فعال فعلی"]) : gate.reasons,
    samplesTest: testM.n,
  };
}

// ---------------------------------------------------------------------------
// inference — latest stored model, used by the entry gate AND the predictor job
// ---------------------------------------------------------------------------

export async function activeModel(exchange: string, symbol: string, timeframe: string, horizon: string) {
  const mv = await prisma.modelVersion.findFirst({
    where: { exchange, symbolScope: symbol, timeframe, horizon, active: true, beatsBaseline: true },
    orderBy: { trainedAt: "desc" },
  });
  if (!mv) return null;
  return { version: mv, model: deserializeModel(mv.weights, parseJson<string[]>(mv.featureNames, [...FEATURE_NAMES])) };
}

export interface ForecastView {
  probability: number;
  confidence: number;
  versionId: string;
  horizon: string;
}

/** predict P(up-barrier first) for a symbol right now — null when no honest model */
export async function predictNow(
  exchange: string, symbol: string, timeframe: string, horizon: string,
): Promise<ForecastView | null> {
  const m = await activeModel(exchange, symbol, timeframe, horizon);
  if (!m) return null;
  const candles = await getCandles({
    symbol, timeframe, exchange,
    start: new Date(Date.now() - 130 * tfMs(timeframe)), end: new Date(),
  });
  if (candles.length < 100) return null;
  const btc = await btcContext(exchange, timeframe, 10).catch(() => []);
  const pre = precompute(candles);
  const ctx: FeatureContext = { btcCloses: btc.map((c) => ({ time: c.time, close: c.close })) };
  const f = featureVectorAt(candles, pre, candles.length - 1, ctx);
  if (!f) return null;
  const p = predictProba(m.model as LogRegModel, f);
  return { probability: p, confidence: Math.abs(p - 0.5) * 2, versionId: m.version.id, horizon };
}

// ---------------------------------------------------------------------------
// entry gate — EV + calibrated-probability check used by live-engine and the
// agent's open_trade. Returns null when no honest model exists (gate off).
// ---------------------------------------------------------------------------

export interface ForecastGateResult {
  applies: boolean;
  allow: boolean;
  probability?: number;
  ev?: number;
  horizon?: string;
  versionId?: string;
  reason?: string;
  /** fractional-Kelly size multiplier, 0.5..1 — never raises risk */
  sizeMult?: number;
}

const ENTRY_COST_PCT = 0.15; // round-trip fees + slippage estimate for EV

/** pure gate math — threshold + EV + quarter-Kelly size multiplier */
export function evalForecast(opts: {
  pDir: number;         // calibrated P(favorable move) for the trade's side
  slPct: number;
  tpPct: number;
  minP?: number;        // probability floor (daily-plan can raise it)
}): { allow: boolean; ev: number; sizeMult: number; reason?: string } {
  const minP = Math.max(opts.minP ?? 0.58, 0.55);
  const ev = opts.pDir * opts.tpPct - (1 - opts.pDir) * opts.slPct - ENTRY_COST_PCT;
  const rr = opts.slPct > 0 ? opts.tpPct / opts.slPct : 0;
  // quarter-Kelly → 0.5..1 multiplier; weak edge shrinks size, never grows it
  const kelly = rr > 0 ? Math.max(opts.pDir - (1 - opts.pDir) / rr, 0) : 0;
  const sizeMult = Math.min(Math.max(0.5 + kelly, 0.5), 1);
  if (opts.pDir < minP)
    return { allow: false, ev, sizeMult, reason: `احتمال مدل ${(opts.pDir * 100).toFixed(1)}٪ < آستانه ${(minP * 100).toFixed(0)}٪` };
  if (ev <= 0)
    return { allow: false, ev, sizeMult, reason: `ارزش مورد انتظار منفی (${ev.toFixed(2)}٪) بعد از هزینه` };
  return { allow: true, ev, sizeMult };
}

export async function forecastGate(opts: {
  exchange: string;
  symbol: string;
  side: "LONG" | "SHORT";
  slPct: number;
  tpPct: number;
  minProbability?: number;   // daily-plan can raise this floor
}): Promise<ForecastGateResult> {
  // any active honest model for this symbol — pick the shortest horizon
  // (the freshest information for an entry decision)
  const mv = await prisma.modelVersion.findFirst({
    where: { exchange: opts.exchange, symbolScope: opts.symbol, active: true, beatsBaseline: true },
    orderBy: { horizon: "asc" },
  });
  if (!mv) return { applies: false, allow: true };

  const f = await predictNow(opts.exchange, opts.symbol, mv.timeframe, mv.horizon).catch(() => null);
  if (!f) return { applies: false, allow: true };

  const pDir = opts.side === "LONG" ? f.probability : 1 - f.probability;
  const d = evalForecast({ pDir, slPct: opts.slPct, tpPct: opts.tpPct, minP: opts.minProbability });
  return {
    applies: true, allow: d.allow, probability: pDir, ev: d.ev,
    horizon: mv.horizon, versionId: f.versionId, reason: d.reason, sizeMult: d.sizeMult,
  };
}

// ---------------------------------------------------------------------------
// prediction recording + resolution — every 15 min from the worker
// ---------------------------------------------------------------------------

export async function recordPredictions(): Promise<number> {
  const agents = await prisma.tradingAgent.findMany({
    where: { status: { in: ["RUNNING", "PAUSED"] } },
    select: { exchange: true, managed: true },
  });
  const pairs = [...new Set(agents.flatMap((a) =>
    parseJson<{ symbol: string }[]>(a.managed, []).map((m) => `${a.exchange}|${m.symbol}`)))];
  let created = 0;
  for (const key of pairs) {
    const [exchange, symbol] = key.split("|");
    for (const cfg of HORIZON_CONFIGS) {
      const has = await prisma.modelVersion.findFirst({
        where: { exchange, symbolScope: symbol, timeframe: cfg.timeframe, horizon: cfg.horizon, active: true },
        select: { id: true },
      });
      if (!has) continue;
      // one prediction per horizon per resolve-window — skip if an unresolved one exists
      const pending = await prisma.prediction.findFirst({
        where: { symbol, exchange, horizon: cfg.horizon, outcome: null }, select: { id: true },
      });
      if (pending) continue;
      const f = await predictNow(exchange, symbol, cfg.timeframe, cfg.horizon).catch(() => null);
      if (!f) continue;
      const candles = await getCandles({
        symbol, timeframe: cfg.timeframe, exchange,
        start: new Date(Date.now() - 5 * tfMs(cfg.timeframe)), end: new Date(),
      }).catch(() => []);
      const price = candles.at(-1)?.close ?? 0;
      await prisma.prediction.create({
        data: {
          modelVersionId: f.versionId, exchange, symbol,
          timeframe: cfg.timeframe, horizon: cfg.horizon,
          probability: f.probability, confidence: f.confidence,
          directionHint: f.probability >= 0.5 ? "LONG" : "SHORT",
          priceAt: price, resolveAt: new Date(Date.now() + (HORIZON_MS[cfg.horizon] ?? 3_600_000)),
        },
      }).then(() => created++).catch(() => {});
    }
  }
  return created;
}

export async function resolvePredictions(): Promise<number> {
  const due = await prisma.prediction.findMany({
    where: { outcome: null, resolveAt: { lte: new Date() } },
    orderBy: { resolveAt: "asc" }, take: 200,
  });
  let resolved = 0;
  for (const p of due) {
    try {
      const cfg = HORIZON_CONFIGS.find((c) => c.horizon === p.horizon && c.timeframe === p.timeframe)
        ?? HORIZON_CONFIGS.find((c) => c.horizon === p.horizon)!;
      const candles = await getCandles({
        symbol: p.symbol, timeframe: p.timeframe, exchange: p.exchange,
        start: p.createdAt, end: new Date(),
      });
      const i0 = candles.findIndex((c) => c.time >= p.createdAt.getTime());
      if (i0 < 0) continue;
      const atrArr = atr(candles, 14);
      // label relative to the prediction candle using its ATR
      const mv = p.modelVersionId
        ? await prisma.modelVersion.findUnique({ where: { id: p.modelVersionId }, select: { barrierK: true } })
        : null;
      const k = mv?.barrierK ?? 1.5;
      const label = tripleBarrierLabel(candles, atrArr, i0, candles.length - i0 - 1, k);
      if (label === null) {
        await prisma.prediction.update({ where: { id: p.id }, data: { outcome: "NEUTRAL", resolvedAt: new Date() } });
      } else {
        const predictedUp = p.probability >= 0.5;
        const win = (label === 1) === predictedUp;
        await prisma.prediction.update({
          where: { id: p.id },
          data: { outcome: win ? "WIN" : "LOSS", resolvedAt: new Date() },
        });
      }
      resolved++;
    } catch { /* next run retries */ }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// live-accuracy monitor — daily; 2 consecutive below-baseline days → deactivate
// ---------------------------------------------------------------------------

export async function checkLiveAccuracy(): Promise<void> {
  const models = await prisma.modelVersion.findMany({ where: { active: true } });
  for (const mv of models) {
    const preds = await prisma.prediction.findMany({
      where: { modelVersionId: mv.id, outcome: { in: ["WIN", "LOSS"] }, resolvedAt: { gte: new Date(Date.now() - 3 * 86_400_000) } },
      select: { outcome: true, probability: true, resolvedAt: true },
      orderBy: { resolvedAt: "asc" },
    });
    if (preds.length < 20) continue;

    // per-day Brier vs the day's base rate — two bad days in a row disables
    const byDay = new Map<string, { p: number[]; y: number[] }>();
    for (const pr of preds) {
      const day = pr.resolvedAt!.toISOString().slice(0, 10);
      const b = byDay.get(day) ?? { p: [], y: [] };
      b.p.push(pr.probability);
      b.y.push(pr.outcome === "WIN" ? 1 : 0);
      byDay.set(day, b);
    }
    const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-2);
    const bad = days.filter(([, v]) => {
      const base = v.y.reduce((s, x) => s + x, 0) / v.y.length;
      const brier = v.p.reduce((s, p, i) => s + (p - v.y[i]) ** 2, 0) / v.p.length;
      const brierBase = v.y.reduce((s, y) => s + (base - y) ** 2, 0) / v.y.length;
      return brier >= brierBase;
    }).length;
    const acc = preds.filter((p) => p.outcome === "WIN").length / preds.length;
    await prisma.modelVersion.update({ where: { id: mv.id }, data: { liveAccuracy: acc } });
    if (bad >= 2) {
      await prisma.modelVersion.update({
        where: { id: mv.id },
        data: { active: false, deactivatedReason: "دقت زنده دو روز پیاپی زیر baseline" },
      });
      const agents = await prisma.tradingAgent.findMany({ where: { managed: { contains: mv.symbolScope }, status: "RUNNING" }, select: { id: true } });
      for (const a of agents) {
        const { journalWrite } = await import("@/modules/agent/journal");
        await journalWrite(a.id, "MODEL_UPDATE",
          `مدل ${mv.horizon} برای ${mv.symbolScope} به‌علت افت دقت زنده غیرفعال شد (دقت ${(acc * 100).toFixed(0)}٪)`,
          { data: { modelVersionId: mv.id, liveAccuracy: acc } });
      }
      logger.warn("forecast model deactivated — live accuracy decayed", { module: "forecast", version: mv.id });
    }
  }
}
