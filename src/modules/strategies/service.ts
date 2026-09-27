import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { INDICATORS, STRATEGY_KINDS, TIMEFRAMES, type StrategyKind } from "@/shared/constants";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";
import { logActivity } from "@/modules/activity/service";

/**
 * Strategy service — CRUD + versioning + clone.
 * Every meaningful config change creates a NEW StrategyVersion.
 */

/** ORDER_BOOK_IMBALANCE kind params — thresholds reuse buy/sellThreshold. */
export interface ObiConfigInput {
  depthLevels?: number;  // top N book levels to sum (default 10)
  emaPeriod?: number;    // EMA smoothing across ticks (default 1 = off)
}

/** MARKET_MAKING kind params. */
export interface MarketMakingConfigInput {
  spreadPct?: number;       // total target spread around mid (default 0.6)
  orderSizePct?: number;    // % of allocated capital per quote (default 10)
  levels?: number;          // quote levels per side (default 1)
  levelStepPct?: number;    // extra spacing between levels (default = spreadPct)
  requotePct?: number;      // min price drift before cancel/replace (default 0.1)
  maxInventoryPct?: number; // stop buying above this inventory share (default 60)
}

/** ATM_SME kind params — symbolic tanh-momentum engine. */
export interface AtmSmeConfigInput {
  volWindow?: number;          // σt window of past returns (default 20)
  gamma?: number;              // tanh sensitivity γ (default 1.5)
  tokenMid?: number;           // |V| B/D boundary (default 0.20)
  tokenExtreme?: number;       // |V| A/E boundary (default 0.60)
  emaPeriod?: number;          // confirmation EMA (default 9)
  useEmaConfirm?: boolean;     // default true
  recoverVt?: number;          // long Vt recovery level (default -0.15)
  weakenVt?: number;           // exit Vt weaken level (default +0.15)
  minPatternWinRate?: number;  // pattern history gate 0..1 (default 0.40; 0 = off)
  minPatternCount?: number;    // min occurrences for the gate (default 1)
  probWindow?: number;         // lookback for pattern stats (default 300)
  bootstrapMargin?: number;    // thin-stats entry margin over recoverVt (default 0.15)
  longPatterns?: string;       // comma-separated entry triples (default "EEC,EED")
  shortPatterns?: string;      // comma-separated exit triples (default "AAC,AAB")
  exitTrigger?: number;        // decay-exit peak Vt (default +0.70)
  exitBack?: number;           // decay-exit fall-back Vt (default +0.40)
  decayLookback?: number;      // candles to look back for the peak (default 10)
}

/** RMM_BSE kind params — rolling min-max breakout engine. */
export interface RmmBseConfigInput {
  channelLen?: number;      // channel lookback k (default 20)
  squeezeAbs?: number;      // |M| squeeze band (default 0.35)
  squeezeBars?: number;     // required squeeze candles (default 5)
  breakoutMt?: number;      // |M| entry zone (default 0.85)
  exitMt?: number;          // exit below this M (default +0.10)
  useVolumeConfirm?: boolean; // default true
  volMult?: number;         // volume ≥ mult × avg (default 1.5)
  volPeriod?: number;       // volume average period (default 20)
}

/** DZS_HMM kind params — dynamic z-score + Markov regime filter. */
export interface DzsHmmConfigInput {
  zWindow?: number;         // rolling μ/σ window (default 60)
  feature?: "return" | "deviation"; // observation Xt (default return)
  emitCenter?: number;      // trend-state emission center (default 0.6)
  emitSigma?: number;       // emission sigma (default 0.35)
  pStay?: number;           // regime persistence (default 0.90)
  bullProb?: number;        // P(bull) entry threshold (default 0.75)
  sCross?: number;          // St upward cross (default +0.33)
  persist?: number;         // candles prob must persist (default 1)
  rangeProbExit?: number;   // exit P(range) (default 0.60)
  bearProbExit?: number;    // exit P(bear) (default 0.60)
}

export interface StrategyInput {
  name: string;
  description?: string;
  kind?: StrategyKind;
  symbol: string;
  timeframe: string;
  buyThreshold: number;
  sellThreshold: number;
  riskPerTradePct: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStop?: boolean;
  trailingStopPct?: number | null;
  maxPositionPct?: number;
  orderType?: string;
  /** SPOT (default) long-only · FUTURES enables shorts + leverage */
  market?: "SPOT" | "FUTURES";
  leverage?: number;
  indicators: StrategyIndicatorConfig[];
  orderBookImbalance?: ObiConfigInput;
  marketMaking?: MarketMakingConfigInput;
  atmSme?: AtmSmeConfigInput;
  rmmBse?: RmmBseConfigInput;
  dzsHmm?: DzsHmmConfigInput;
  /** smart mode — symbolic engines learn from their own closed trades */
  smart?: boolean;
}

const inRange = (v: number | undefined, min: number, max: number) =>
  v === undefined || (v >= min && v <= max);

/** comma-separated 3-letter token patterns over the A–E alphabet */
const validPatterns = (s: string | undefined) =>
  s === undefined || /^[A-Ea-e]{3}(,[A-Ea-e]{3})*$/.test(s.trim());

export function validateStrategyInput(input: StrategyInput) {
  if (!input.name?.trim()) throw new AppError("VALIDATION", 400, { field: "name" });
  if (!TIMEFRAMES.includes(input.timeframe as never)) throw new AppError("INVALID_TIMEFRAME", 400);
  const kind: StrategyKind = input.kind ?? "SIGNAL";
  if (!STRATEGY_KINDS.includes(kind)) throw new AppError("VALIDATION", 400, { field: "kind" });

  // market type — futures only for directional (non-MM) kinds
  if (input.market !== undefined && !["SPOT", "FUTURES"].includes(input.market)) {
    throw new AppError("VALIDATION", 400, { field: "market" });
  }
  if (input.market === "FUTURES") {
    if (kind === "MARKET_MAKING") throw new AppError("VALIDATION", 400, { field: "market", reason: "futures not supported for market making" });
    if (!inRange(input.leverage, 1, 10)) throw new AppError("VALIDATION", 400, { field: "leverage" });
  }

  const indicators = input.indicators ?? [];
  const enabled = indicators.filter((i) => i.enabled);
  const scoring = enabled.filter((i) => i.name.toUpperCase() !== "ATR"); // ATR is risk-only
  // candle-driven strategies need at least one scoring indicator;
  // order-book kinds may still attach ATR for dynamic stops
  if (kind === "SIGNAL" && scoring.length === 0) {
    throw new AppError("VALIDATION", 400, { reason: "no enabled scoring indicator" });
  }
  for (const ind of indicators) {
    if (!INDICATORS.includes(ind.name.toUpperCase() as never)) {
      throw new AppError("VALIDATION", 400, { indicator: ind.name });
    }
    if (ind.enabled && (ind.weight < 0 || ind.weight > 1)) {
      throw new AppError("VALIDATION", 400, { reason: "weight must be 0..1" });
    }
  }

  if (kind === "MARKET_MAKING") {
    const mm = input.marketMaking ?? {};
    if (
      !inRange(mm.spreadPct, 0.01, 10) ||
      !inRange(mm.orderSizePct, 0.1, 100) ||
      !inRange(mm.levels, 1, 10) ||
      !inRange(mm.levelStepPct, 0, 10) ||
      !inRange(mm.requotePct, 0, 10) ||
      !inRange(mm.maxInventoryPct, 1, 100)
    ) {
      throw new AppError("VALIDATION", 400, { field: "marketMaking" });
    }
    return; // signal thresholds are unused for market making
  }

  if (kind === "ATM_SME") {
    const c = input.atmSme ?? {};
    if (
      !inRange(c.volWindow, 2, 500) ||
      !inRange(c.gamma, 0.01, 100) ||
      !inRange(c.tokenMid, 0.01, 0.99) ||
      !inRange(c.tokenExtreme, 0.01, 1) ||
      !inRange(c.emaPeriod, 1, 200) ||
      !inRange(c.recoverVt, -1, 1) ||
      !inRange(c.weakenVt, -1, 1) ||
      !inRange(c.minPatternWinRate, 0, 1) ||
      !inRange(c.minPatternCount, 0, 100) ||
      !inRange(c.probWindow, 10, 5000) ||
      !inRange(c.exitTrigger, -1, 1) ||
      !inRange(c.exitBack, -1, 1) ||
      !inRange(c.decayLookback, 1, 200) ||
      !inRange(c.bootstrapMargin, 0, 1) ||
      !validPatterns(c.longPatterns) ||
      !validPatterns(c.shortPatterns) ||
      (c.tokenMid !== undefined && c.tokenExtreme !== undefined && c.tokenMid >= c.tokenExtreme)
    ) {
      throw new AppError("VALIDATION", 400, { field: "atmSme" });
    }
  }
  if (kind === "RMM_BSE") {
    const c = input.rmmBse ?? {};
    if (
      !inRange(c.channelLen, 2, 500) ||
      !inRange(c.squeezeAbs, 0.01, 1) ||
      !inRange(c.squeezeBars, 1, 100) ||
      !inRange(c.breakoutMt, 0.01, 1) ||
      !inRange(c.exitMt, -1, 1) ||
      !inRange(c.volMult, 0.1, 100) ||
      !inRange(c.volPeriod, 1, 500)
    ) {
      throw new AppError("VALIDATION", 400, { field: "rmmBse" });
    }
  }
  if (kind === "DZS_HMM") {
    const c = input.dzsHmm ?? {};
    if (
      !inRange(c.zWindow, 5, 1000) ||
      !inRange(c.emitCenter, 0.05, 1) ||
      !inRange(c.emitSigma, 0.01, 2) ||
      !inRange(c.pStay, 0.5, 0.999) ||
      !inRange(c.bullProb, 0.5, 0.99) ||
      !inRange(c.sCross, 0.01, 1) ||
      !inRange(c.persist, 1, 20) ||
      !inRange(c.rangeProbExit, 0.1, 0.99) ||
      !inRange(c.bearProbExit, 0.1, 0.99)
    ) {
      throw new AppError("VALIDATION", 400, { field: "dzsHmm" });
    }
  }

  if (input.buyThreshold <= input.sellThreshold) {
    throw new AppError("VALIDATION", 400, { reason: "buyThreshold must exceed sellThreshold" });
  }
  if (kind === "ORDER_BOOK_IMBALANCE") {
    const obi = input.orderBookImbalance ?? {};
    if (!inRange(obi.depthLevels, 1, 50) || !inRange(obi.emaPeriod, 1, 200)) {
      throw new AppError("VALIDATION", 400, { field: "orderBookImbalance" });
    }
    if (
      input.buyThreshold <= 0 || input.buyThreshold > 1 ||
      input.sellThreshold >= 0 || input.sellThreshold < -1
    ) {
      throw new AppError("VALIDATION", 400, { reason: "OBI thresholds must be within (-1,0) / (0,1)" });
    }
  }
}

async function createVersion(
  strategyId: string,
  input: StrategyInput,
  versionNumber: number,
) {
  return prisma.strategyVersion.create({
    data: {
      strategyId,
      versionNumber,
      kind: input.kind ?? "SIGNAL",
      symbol: input.symbol.toUpperCase(),
      timeframe: input.timeframe,
      buyThreshold: input.buyThreshold,
      sellThreshold: input.sellThreshold,
      riskPerTradePct: input.riskPerTradePct,
      stopLossPct: input.stopLossPct,
      takeProfitPct: input.takeProfitPct,
      trailingStop: input.trailingStop ?? false,
      trailingStopPct: input.trailingStopPct ?? null,
      maxPositionPct: input.maxPositionPct ?? 100,
      orderType: input.orderType ?? "MARKET",
      config: JSON.stringify(input),
      indicators: {
        create: (input.indicators ?? []).map((ind, i) => ({
          name: ind.name.toUpperCase(),
          parameters: JSON.stringify(ind.parameters ?? {}),
          weight: ind.weight,
          enabled: ind.enabled,
          buyCondition: JSON.stringify(ind.buyCondition ?? {}),
          sellCondition: JSON.stringify(ind.sellCondition ?? {}),
          sortOrder: i,
        })),
      },
    },
    include: { indicators: true },
  });
}

export async function createStrategy(userId: string, input: StrategyInput, origin = "USER") {
  validateStrategyInput(input);
  const strategy = await prisma.strategy.create({
    data: { userId, name: input.name.trim(), description: input.description, origin },
  });
  const version = await createVersion(strategy.id, input, 1);
  await logActivity({ userId, action: "CREATE_STRATEGY", entityType: "strategy", entityId: strategy.id });
  return { strategy, version };
}

/** Edit creates a new version — old versions stay immutable. */
export async function updateStrategy(userId: string, strategyId: string, input: StrategyInput) {
  const strategy = await prisma.strategy.findFirst({
    where: { id: strategyId, userId, status: { not: "DELETED" } },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404);
  validateStrategyInput(input);
  const last = await prisma.strategyVersion.findFirst({
    where: { strategyId },
    orderBy: { versionNumber: "desc" },
  });
  const version = await createVersion(strategyId, input, (last?.versionNumber ?? 0) + 1);
  await prisma.strategy.update({
    where: { id: strategyId },
    data: { name: input.name.trim(), description: input.description },
  });
  await logActivity({ userId, action: "EDIT_STRATEGY", entityType: "strategy", entityId: strategyId });
  return version;
}

/**
 * Delete a strategy.
 * - Blocked while a live instance is active (user must stop it first).
 * - If any marketplace listing has purchases, the strategy is soft-deleted
 *   (status=DELETED, listings archived) so purchase records stay intact.
 * - Otherwise the whole tree is hard-deleted in one transaction.
 */
export async function deleteStrategy(userId: string, strategyId: string) {
  const strategy = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
  if (!strategy || strategy.status === "DELETED") throw new AppError("NOT_FOUND", 404);

  // only genuinely-active instances block deletion — PAUSED/DEGRADED rows are
  // idle (engine skips them / errors out) and are stopped inside the transaction
  const activeLive = await prisma.liveStrategy.findFirst({
    where: { strategyId, status: { in: ["STARTING", "RUNNING", "STOPPING"] } },
    select: { id: true },
  });
  if (activeLive) throw new AppError("STRATEGY_HAS_LIVE", 400);

  const purchased = await prisma.strategyPurchase.count({
    where: { listing: { strategyId } },
  });

  await prisma.$transaction(async (tx) => {
    // parked instances (PAUSED/DEGRADED) must not outlive their strategy —
    // in the soft-delete path the live rows would otherwise stay and keep ticking
    await tx.liveStrategy.updateMany({
      where: { strategyId, status: { in: ["PAUSED", "DEGRADED"] } },
      data: { status: "STOPPED", stoppedAt: new Date() },
    });
    if (purchased > 0) {
      await tx.marketplaceListing.updateMany({ where: { strategyId }, data: { status: "ARCHIVED" } });
      await tx.strategy.update({ where: { id: strategyId }, data: { status: "DELETED" } });
      return;
    }
    await tx.marketplaceListing.deleteMany({ where: { strategyId } });

    const liveIds = (
      await tx.liveStrategy.findMany({ where: { strategyId }, select: { id: true } })
    ).map((l) => l.id);
    if (liveIds.length) {
      await tx.order.updateMany({ where: { liveStrategyId: { in: liveIds } }, data: { liveStrategyId: null } });
      await tx.trade.updateMany({ where: { liveStrategyId: { in: liveIds } }, data: { liveStrategyId: null } });
      await tx.liveStrategy.deleteMany({ where: { id: { in: liveIds } } });
    }

    const btIds = (
      await tx.backtest.findMany({ where: { strategyId }, select: { id: true } })
    ).map((b) => b.id);
    if (btIds.length) {
      await tx.backtestTrade.deleteMany({ where: { backtestId: { in: btIds } } });
      await tx.backtest.deleteMany({ where: { id: { in: btIds } } });
    }

    await tx.strategy.delete({ where: { id: strategyId } }); // versions + indicators cascade
  });

  await logActivity({ userId, action: "DELETE_STRATEGY", entityType: "strategy", entityId: strategyId });
  return { soft: purchased > 0 };
}

export async function latestVersion(strategyId: string) {
  return prisma.strategyVersion.findFirst({
    where: { strategyId },
    orderBy: { versionNumber: "desc" },
    include: { indicators: { orderBy: { sortOrder: "asc" } } },
  });
}

/**
 * Clone — creates an independent strategy + v1 from the given version.
 * Records sourceStrategyId + parentVersionId for the clone/resell rules.
 */
export async function cloneStrategy(opts: {
  userId: string;
  sourceVersionId: string;
  name?: string;
  purchasedListingId?: string;
}) {
  const source = await prisma.strategyVersion.findUnique({
    where: { id: opts.sourceVersionId },
    include: { indicators: true, strategy: true },
  });
  if (!source) throw new AppError("NOT_FOUND", 404);

  const config = JSON.parse(source.config) as StrategyInput;
  const strategy = await prisma.strategy.create({
    data: {
      userId: opts.userId,
      name: opts.name ?? `${source.strategy.name} (کپی)`,
      description: source.strategy.description,
      sourceStrategyId: source.strategyId,
      parentVersionId: source.id,
      origin: opts.purchasedListingId ? "PURCHASED" : "CLONED",
    },
  });
  const version = await createVersion(strategy.id, { ...config, name: strategy.name }, 1);
  await logActivity({ userId: opts.userId, action: "CLONE_STRATEGY", entityType: "strategy", entityId: strategy.id });
  return { strategy, version };
}

/**
 * Resell guard — a purchased/cloned strategy may only be listed for sale
 * if the buyer's config materially differs from the parent version.
 */
export async function hasMaterialChanges(versionId: string): Promise<boolean> {
  const version = await prisma.strategyVersion.findUnique({
    where: { id: versionId },
    include: { indicators: true, strategy: true },
  });
  if (!version?.strategy.parentVersionId) return true; // original → sellable
  const parent = await prisma.strategyVersion.findUnique({
    where: { id: version.strategy.parentVersionId },
    include: { indicators: true, strategy: true },
  });
  if (!parent) return true;
  const strip = (v: typeof version) => ({
    symbol: v.symbol, timeframe: v.timeframe,
    buyThreshold: v.buyThreshold, sellThreshold: v.sellThreshold,
    riskPerTradePct: v.riskPerTradePct, stopLossPct: v.stopLossPct, takeProfitPct: v.takeProfitPct,
    indicators: v.indicators.map((i) => ({ n: i.name, p: i.parameters, w: i.weight, e: i.enabled })),
  });
  return JSON.stringify(strip(version)) !== JSON.stringify(strip(parent));
}
