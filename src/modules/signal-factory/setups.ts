import crypto from "node:crypto";
import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { ema, rsi, atr } from "@/modules/indicators/engine";
import { dataSourceFor } from "@/modules/scalping/source";
import { journalWrite } from "@/modules/agent/journal";
import { getSetting, setSetting } from "@/modules/settings/service";
import { clamp, faNumber } from "@/shared/utils";
import { configTimeframes, getOrCreateConfig, pairFilter, pairVolume24h } from "./config";
import { dataFresh, getCandles } from "./data";
import { extractLevels, levelsAbove, levelsBelow, type SrLevel } from "./levels";
import { marketContext, trendOf, type MarketContext, type MarketRegime } from "./context";
import { systemAgentId } from "./jobs";
import type { Candle } from "@/modules/exchanges/types";
import type { SignalMakerConfig } from "@/generated/prisma/client";

/**
 * Setup generation engine — conditional, level-anchored setups (never market
 * entries). Every level comes from a named formula/source recorded in
 * levelsMeta; RR to TP1 ≥ 1.5 is a hard gate. Active setups on the same
 * symbol+direction are refreshed in place, never duplicated.
 */

export const MIN_RR = 1.5;
export const SETUP_KINDS = [
  "LONG_BREAKOUT", "LONG_BOUNCE", "SHORT_BREAKDOWN", "SHORT_REJECTION",
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

const ACTIVE_STATES = ["PROPOSED", "BACKTESTED", "WAITING_TRIGGER", "PAPER_OPEN"];
const MAX_SCAN_PAIRS = 25;
const TOP_N = 10;
const MAX_PER_SYMBOL = 2;
const WARMUP = 100;

// ---------------------------------------------------------------------------
// Per-pair analysis
// ---------------------------------------------------------------------------

export interface PairAnalysis {
  symbol: string;
  timeframe: string;
  price: number;
  atr: number;
  atrPct: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  volZ: number;
  trend: "UP" | "DOWN" | "RANGE";
  rsVsBtc: number | null;     // % excess return vs BTC over 24 candles
  levels: SrLevel[];
}

function idxAtOrBefore(xs: { time: number }[], t: number): number {
  let lo = 0, hi = xs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 24-candle excess return vs BTC (time-aligned, both series same timeframe). */
export function relativeStrength(candles: Candle[], btc: Candle[] | undefined, n = 24): number | null {
  if (!btc || btc.length < 2 || candles.length < n + 1) return null;
  const c0 = candles[candles.length - 1 - n], c1 = candles.at(-1)!;
  const b0 = idxAtOrBefore(btc, c0.time), b1 = idxAtOrBefore(btc, c1.time);
  if (b0 < 0 || b1 <= b0 || c0.close <= 0 || btc[b0].close <= 0) return null;
  return (c1.close / c0.close - (btc[b1].close / btc[b0].close)) * 100;
}

export function analyzePair(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  btcCandles?: Candle[],
): PairAnalysis | null {
  if (candles.length < WARMUP) return null;
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1)!;
  const atrArr = atr(candles, 14);
  const atrNow = atrArr.at(-1)!;
  if (!Number.isFinite(atrNow) || atrNow <= 0 || price <= 0) return null;

  const vols = candles.map((c) => c.volume);
  const win = vols.slice(-21, -1);
  const vMean = win.reduce((s, v) => s + v, 0) / Math.max(win.length, 1);
  const vStd = Math.sqrt(win.reduce((s, v) => s + (v - vMean) ** 2, 0) / Math.max(win.length, 1));
  const volZ = vStd > 0 ? (vols.at(-1)! - vMean) / vStd : 0;

  return {
    symbol, timeframe, price,
    atr: atrNow,
    atrPct: (atrNow / price) * 100,
    ema20: ema(closes, 20).at(-1)!,
    ema50: ema(closes, 50).at(-1)!,
    ema200: ema(closes, 200).at(-1)!,
    rsi: rsi(closes, 14).at(-1)!,
    volZ,
    trend: trendOf(candles),
    rsVsBtc: relativeStrength(candles, btcCandles),
    levels: extractLevels(candles, { timeframe }),
  };
}

// ---------------------------------------------------------------------------
// Setup construction — pure, testable
// ---------------------------------------------------------------------------

export interface LevelsMeta {
  trigger: string;
  entry: string;
  sl: string;
  tp1: string;
  tp2: string;
  invalidate: string;
}

export interface SetupDraft {
  symbol: string;
  direction: "LONG" | "SHORT";
  kind: SetupKind;
  timeframe: string;
  triggerPrice: number;
  confirmRule: string;
  entryLow: number;
  entryHigh: number;
  tp1: number;
  tp2: number;
  sl: number;
  invalidatePrice: number;
  rr: number;
  score: number;
  confidence: number;
  reasonFa: string;
  levelsMeta: LevelsMeta;
  expiresAt: Date;
  priceAtScan: number;
  executable: boolean;
}

interface BuildCtx {
  regime: MarketRegime;
  marketType: string;
  now: number;
}

interface RawSetup {
  kind: SetupKind;
  triggerLevel: SrLevel;
  distA: number;             // |price − trigger| in ATR
  entryLow: number;
  entryHigh: number;
  sl: number;
  slSrc: string;
  invalidate: number;
  invalidateSrc: string;
  confirmRule: string;
  reasonFa: string;
}

/** First level past `from` (direction-aware) whose RR vs risk clears MIN_RR;
 *  falls back to a 2×risk measured move when no level qualifies. */
function pickTargets(
  levels: SrLevel[],
  from: number,
  entry: number,
  risk: number,
  dir: 1 | -1,
): { tp1: number; tp2: number; tp1Src: string; tp2Src: string; rr: number } | null {
  if (risk <= 0) return null;
  const after = dir === 1 ? levelsAbove(levels, from) : levelsBelow(levels, from);
  const tp1Lvl = after.find((l) => Math.abs(l.price - entry) / risk >= MIN_RR);
  const tp1 = tp1Lvl ? tp1Lvl.price : entry + dir * 2 * risk;
  const tp1Src = tp1Lvl ? tp1Lvl.source : "حرکت اندازه‌گیری‌شده R:R×2";
  const rr = Math.abs(tp1 - entry) / risk;
  const past1 = dir === 1 ? levelsAbove(levels, tp1) : levelsBelow(levels, tp1);
  const tp2 = past1[0] ? past1[0].price : tp1 + dir * 1.5 * risk;
  const tp2Src = past1[0] ? past1[0].source : "حرکت اندازه‌گیری‌شده R:R×3.5";
  return { tp1, tp2, tp1Src, tp2Src, rr };
}

/** Raw geometry per kind — null when no qualifying level is in range. */
function rawSetups(a: PairAnalysis): RawSetup[] {
  const A = a.atr;
  const above = levelsAbove(a.levels, a.price);
  const below = levelsBelow(a.levels, a.price);
  const [res, sup] = [above[0], below[0]];
  const out: RawSetup[] = [];
  const tf = a.timeframe;

  if (res) {
    const distA = (res.price - a.price) / A;
    if (distA >= 0.3 && distA <= 4) {
      const entryHigh = res.price + 0.3 * A;
      out.push({
        kind: "LONG_BREAKOUT", triggerLevel: res, distA,
        entryLow: res.price, entryHigh,
        sl: res.price - 1.2 * A, slSrc: `ATR×1.2 پشت ${res.source}`,
        invalidate: sup ? sup.price : a.price - 1.5 * A,
        invalidateSrc: sup ? sup.source : "ATR×1.5 زیر قیمت فعلی",
        confirmRule: "CLOSE_ABOVE_TF",
        reasonFa: `شکست مقاومت ${faNumber(res.price, true)} (${res.source}) با کلوز ${tf} بالای سطح`,
      });
    }
    if (distA <= 1.5) {
      out.push({
        kind: "SHORT_REJECTION", triggerLevel: res, distA,
        entryLow: res.price - 0.4 * A, entryHigh: res.price + 0.2 * A,
        sl: res.price + 0.9 * A, slSrc: `ATR×0.9 پشت ${res.source}`,
        invalidate: res.price + 0.6 * A, invalidateSrc: `کلوز ${tf} بالای ${res.source}`,
        confirmRule: "CLOSE_IN_ZONE_BEAR_TF",
        reasonFa: `برگشت از مقاومت ${faNumber(res.price, true)} (${res.source}) — کلوز ${tf} ردکننده در ناحیه`,
      });
    }
  }
  if (sup) {
    const distA = (a.price - sup.price) / A;
    if (distA >= 0.3 && distA <= 4) {
      out.push({
        kind: "SHORT_BREAKDOWN", triggerLevel: sup, distA,
        entryLow: sup.price - 0.3 * A, entryHigh: sup.price,
        sl: sup.price + 1.2 * A, slSrc: `ATR×1.2 پشت ${sup.source}`,
        invalidate: res ? res.price : a.price + 1.5 * A,
        invalidateSrc: res ? res.source : "ATR×1.5 بالای قیمت فعلی",
        confirmRule: "CLOSE_BELOW_TF",
        reasonFa: `شکست حمایت ${faNumber(sup.price, true)} (${sup.source}) با کلوز ${tf} زیر سطح`,
      });
    }
    if (distA <= 1.5) {
      out.push({
        kind: "LONG_BOUNCE", triggerLevel: sup, distA,
        entryLow: sup.price - 0.2 * A, entryHigh: sup.price + 0.4 * A,
        sl: sup.price - 0.9 * A, slSrc: `ATR×0.9 پشت ${sup.source}`,
        invalidate: sup.price - 0.6 * A, invalidateSrc: `کلوز ${tf} زیر ${sup.source}`,
        confirmRule: "CLOSE_IN_ZONE_BULL_TF",
        reasonFa: `برگشت از حمایت ${faNumber(sup.price, true)} (${sup.source}) — کلوز ${tf} تأییدکننده در ناحیه`,
      });
    }
  }
  return out;
}

const REGIME_ALIGN: Record<"LONG" | "SHORT", Record<MarketRegime, number>> = {
  LONG: { AGGRESSIVE: 1, NEUTRAL: 0.55, DEFENSIVE: 0.15 },
  SHORT: { AGGRESSIVE: 0.15, NEUTRAL: 0.55, DEFENSIVE: 1 },
};

function scoreSetup(a: PairAnalysis, raw: RawSetup, rr: number, regime: MarketRegime): { score: number; confidence: number } {
  const dir = raw.kind.startsWith("LONG") ? "LONG" : "SHORT";
  const rrPart = clamp((rr - MIN_RR) / 1.5, 0, 1);
  const volPart = clamp(a.volZ / 2 + 0.5, 0, 1);
  const rs = a.rsVsBtc;
  const rsPart = rs === null ? 0.5
    : dir === "LONG" ? clamp((rs + 5) / 10, 0, 1) : clamp((-rs + 5) / 10, 0, 1);
  const score = Math.round(100 * (
    0.3 * rrPart + 0.2 * raw.triggerLevel.strength +
    0.2 * REGIME_ALIGN[dir][regime] + 0.15 * volPart + 0.15 * rsPart
  ));
  const trendAligned = (dir === "LONG" && a.trend === "UP") || (dir === "SHORT" && a.trend === "DOWN");
  const confidence = clamp(0.3 + 0.65 * (score / 100) + (trendAligned ? 0.05 : -0.05), 0.05, 0.95);
  return { score, confidence };
}

const KIND_DIR: Record<SetupKind, "LONG" | "SHORT"> = {
  LONG_BREAKOUT: "LONG", LONG_BOUNCE: "LONG",
  SHORT_BREAKDOWN: "SHORT", SHORT_REJECTION: "SHORT",
};

/** Generate the conditional setups a pair qualifies for — RR<1.5 dropped. */
export function buildSetups(a: PairAnalysis, ctx: BuildCtx): SetupDraft[] {
  const out: SetupDraft[] = [];
  for (const raw of rawSetups(a)) {
    const dir = KIND_DIR[raw.kind];
    const sign = dir === "LONG" ? 1 : -1;
    const entry = (raw.entryLow + raw.entryHigh) / 2;
    const risk = Math.abs(entry - raw.sl);
    const tpEntry = dir === "LONG" ? raw.entryHigh : raw.entryLow;
    const tps = pickTargets(a.levels, tpEntry, entry, risk, sign as 1 | -1);
    if (!tps || tps.rr < MIN_RR) continue;

    const { score, confidence } = scoreSetup(a, raw, tps.rr, ctx.regime);
    const expiryH = clamp(24 + Math.round(raw.distA * 6), 24, 48);
    out.push({
      symbol: a.symbol,
      direction: dir,
      kind: raw.kind,
      timeframe: a.timeframe,
      triggerPrice: raw.triggerLevel.price,
      confirmRule: raw.confirmRule,
      entryLow: raw.entryLow,
      entryHigh: raw.entryHigh,
      tp1: tps.tp1, tp2: tps.tp2,
      sl: raw.sl,
      invalidatePrice: raw.invalidate,
      rr: Math.round(tps.rr * 100) / 100,
      score, confidence,
      reasonFa: raw.reasonFa,
      levelsMeta: {
        trigger: raw.triggerLevel.source,
        entry: `${raw.triggerLevel.source} ±ATR`,
        sl: raw.slSrc,
        tp1: tps.tp1Src,
        tp2: tps.tp2Src,
        invalidate: raw.invalidateSrc,
      },
      expiresAt: new Date(ctx.now + expiryH * 3_600_000),
      priceAtScan: a.price,
      executable: !(dir === "SHORT" && ctx.marketType === "SPOT"),
    });
  }
  return out;
}

/** kind + bucketed params → stable pattern key for SetupType aggregation. */
export function typeKeyOf(d: SetupDraft, regime: MarketRegime): { typeKey: string; paramsHash: string } {
  const paramsHash = crypto.createHash("sha256")
    .update(JSON.stringify({
      kind: d.kind,
      tf: d.timeframe,
      rr: Math.round(d.rr * 2) / 2,
      trigger: d.levelsMeta.trigger.replace(/×\d+$/, ""),
      regime,
    }))
    .digest("hex").slice(0, 12);
  return { typeKey: `${d.kind}:${paramsHash}`, paramsHash };
}

// ---------------------------------------------------------------------------
// Ranking + persistence
// ---------------------------------------------------------------------------

/** Score-desc top-10 with at most 2 setups per symbol. */
export function rankTop(drafts: SetupDraft[], topN = TOP_N, perSymbol = MAX_PER_SYMBOL): SetupDraft[] {
  const counts = new Map<string, number>();
  const out: SetupDraft[] = [];
  for (const d of [...drafts].sort((x, y) => y.score - x.score)) {
    if ((counts.get(d.symbol) ?? 0) >= perSymbol) continue;
    counts.set(d.symbol, (counts.get(d.symbol) ?? 0) + 1);
    out.push(d);
    if (out.length >= topN) break;
  }
  return out;
}

/**
 * Persist the ranked drafts. An ACTIVE setup on the same symbol+direction is
 * refreshed in place (dedupe); otherwise a new row + SetupType upsert.
 */
export async function persistSetups(
  cfg: Pick<SignalMakerConfig, "id" | "userId" | "exchange" | "marketType">,
  drafts: SetupDraft[],
  regime: MarketRegime,
): Promise<{ created: number; updated: number; kept: SetupDraft[] }> {
  // degraded patterns rank lower — the SetupType weight scales the draft's
  // score before the top-N cut and is what gets persisted on the row
  const keyByDraft = new Map<SetupDraft, { typeKey: string; paramsHash: string }>();
  for (const d of drafts) keyByDraft.set(d, typeKeyOf(d, regime));
  const keys = [...new Set([...keyByDraft.values()].map((k) => k.typeKey))];
  const weights = new Map(
    (await prisma.setupType.findMany({
      where: { key: { in: keys } },
      select: { key: true, weight: true },
    })).map((t) => [t.key, t.weight]),
  );
  for (const d of drafts) {
    const w = weights.get(keyByDraft.get(d)!.typeKey) ?? 1;
    if (w !== 1) d.score = Math.max(0, Math.round(d.score * w));
  }

  const kept = rankTop(drafts);
  let created = 0, updated = 0;
  for (const d of kept) {
    const { typeKey, paramsHash } = keyByDraft.get(d)!;
    await prisma.setupType.upsert({
      where: { key: typeKey },
      create: { key: typeKey, kind: d.kind, paramsHash },
      update: {},
    });
    const data = {
      exchange: cfg.exchange,
      symbol: d.symbol,
      marketType: cfg.marketType,
      direction: d.direction,
      kind: d.kind,
      typeKey,
      timeframe: d.timeframe,
      triggerPrice: d.triggerPrice,
      confirmRule: d.confirmRule,
      entryLow: d.entryLow,
      entryHigh: d.entryHigh,
      tp1: d.tp1,
      tp2: d.tp2,
      sl: d.sl,
      invalidatePrice: d.invalidatePrice,
      rr: d.rr,
      score: d.score,
      confidence: d.confidence,
      reasonFa: d.reasonFa,
      levelsMeta: JSON.stringify(d.levelsMeta),
      executable: d.executable,
      expiresAt: d.expiresAt,
      priceAtScan: d.priceAtScan,
    };
    const existing = await prisma.setup.findFirst({
      where: { configId: cfg.id, symbol: d.symbol, direction: d.direction, state: { in: ACTIVE_STATES } },
      select: { id: true },
    });
    if (existing) {
      await prisma.setup.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.setup.create({ data: { ...data, userId: cfg.userId, configId: cfg.id } });
      created++;
    }
  }
  return { created, updated, kept };
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

export interface ScanResult {
  scanned: number;
  stale: string[];
  produced: number;
  kept: number;
  top: { symbol: string; kind: string; direction: string; score: number }[];
  context: MarketContext | null;
}

const lastScanKey = (userId: string) => `sf:lastScan:${userId}`;
export const lastScanAt = (userId: string) => getSetting<number>(lastScanKey(userId)).catch(() => 0);

/**
 * Candidate symbols for a config. KuCoin FUTURES takes the perpetual contract
 * list (DB pairs are spot-dashed symbols); everything else goes through the
 * synced-pair liquidity filter from stage 1.
 */
export async function candidateSymbols(
  cfg: Pick<SignalMakerConfig, "exchange" | "marketType" | "quote" | "minVolume24h">,
): Promise<string[]> {
  if (cfg.marketType === "FUTURES") {
    try {
      const src = dataSourceFor(cfg.exchange, "PERPETUAL");
      const stats = await src?.getMarketStats();
      const rows = (stats ?? [])
        .filter((r) => !r.isClosed && r.quoteCurrency.toUpperCase() === cfg.quote.toUpperCase()
          && r.volumeQuote24h >= cfg.minVolume24h)
        .sort((a, b) => b.volumeQuote24h - a.volumeQuote24h);
      if (rows.length) return rows.map((r) => r.symbol).slice(0, MAX_SCAN_PAIRS);
    } catch (e) {
      logger.warn("futures candidates failed — falling back to pairs", {
        module: "signal-factory", errorCode: String(e).slice(0, 120),
      });
    }
  }
  const pairs = await pairFilter(cfg);
  return pairs
    .sort((a, b) => pairVolume24h(b) - pairVolume24h(a))
    .map((p) => p.symbol)
    .slice(0, MAX_SCAN_PAIRS);
}

export async function scanUser(userId: string): Promise<ScanResult | { skipped: string }> {
  const cfg = await getOrCreateConfig(userId);
  if (!cfg.enabled) return { skipped: "disabled" };
  if (!dataFresh(cfg.exchange)) {
    logger.warn("scan skipped — data flagged stale by watchdog", { module: "signal-factory", userId });
    return { skipped: "stale" };
  }
  const tf = configTimeframes(cfg)[0];

  // BTC context — on failure degrade to NEUTRAL rather than blocking the scan
  let context: MarketContext | null = null;
  let btcCandles: Candle[] | undefined;
  try {
    context = await marketContext({ ...cfg, timeframe: tf });
    btcCandles = context.refCandles;
  } catch (e) {
    logger.warn("market context failed — scanning with NEUTRAL regime", {
      module: "signal-factory", userId, errorCode: String(e).slice(0, 120),
    });
  }
  const regime: MarketRegime = context?.regime ?? "NEUTRAL";

  const symbols = await candidateSymbols(cfg);
  const stale: string[] = [];
  const drafts: SetupDraft[] = [];
  let scanned = 0;

  for (const symbol of symbols) {
    try {
      const candles = await getCandles(cfg.exchange, symbol, tf);
      const a = analyzePair(symbol, tf, candles, btcCandles);
      if (!a) continue;
      drafts.push(...buildSetups(a, { regime, marketType: cfg.marketType, now: Date.now() }));
      scanned++;
    } catch (e) {
      stale.push(symbol);
      logger.warn("scan skipped pair — stale/failed data", {
        module: "signal-factory", symbol, errorCode: String(e instanceof Error ? e.message : e).slice(0, 120),
      });
    }
  }

  const { created, updated, kept } = await persistSetups(cfg, drafts, regime);
  await setSetting(lastScanKey(userId), Date.now());

  const result: ScanResult = {
    scanned, stale,
    produced: drafts.length,
    kept: kept.length,
    top: kept.slice(0, 5).map((d) => ({ symbol: d.symbol, kind: d.kind, direction: d.direction, score: d.score })),
    context,
  };
  await journalWrite(
    await systemAgentId(userId), "SCAN",
    `اسکن ${scanned} جفت در ${cfg.exchange}/${cfg.marketType} — ${kept.length} ستاپ فعال (${created} جدید، ${updated} به‌روز)`,
    {
      reason: stale.length ? `داده کهنه/ناموفق: ${stale.join("، ")}` : undefined,
      data: { regime, produced: drafts.length, stale, top: result.top },
    },
  );
  return result;
}

/** Scheduler entry — every enabled config whose scan interval has elapsed. */
export async function scanDueConfigs(): Promise<number> {
  const configs = await prisma.signalMakerConfig.findMany({ where: { enabled: true } });
  let ran = 0;
  for (const cfg of configs) {
    const last = Number(await getSetting<number>(lastScanKey(cfg.userId)).catch(() => 0)) || 0;
    if (Date.now() - last < cfg.scanEveryHours * 3_600_000) continue;
    await scanUser(cfg.userId).catch((e) =>
      logger.warn("scheduled scan failed", { module: "signal-factory", userId: cfg.userId, errorCode: String(e).slice(0, 120) }));
    ran++;
  }
  return ran;
}
