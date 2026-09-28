import { AppError } from "@/shared/errors";
import { logger } from "@/infrastructure/logging/logger";
import { mergeScalpConfig, type ScalpConfig } from "./config";
import { configuredSources } from "./source";
import { scorePair } from "./scorer";
import type { MarketDataSource, PairRank, PairSnapshot, RankResult } from "./types";

/**
 * Scalping scanner service — read-only market analysis. No orders, no trading.
 *
 * Flow: bulk stats (1 request) → cheap prefilter → top-N by USD volume get
 * order-book + candle enrichment (bounded concurrency) → score → rank.
 */

export interface RankQuery {
  exchange?: string;
  quote?: string;          // IRT | USDT | all
  base?: string;           // base-asset substring filter
  market?: string;         // SPOT | PERPETUAL | all
  minVolumeUsd?: number;   // display filter on top of hard thresholds
  includeExcluded?: boolean;
  orderSizeUsd?: number;
  candleTimeframe?: string;
  bookLimit?: number;
  feePctPerSide?: number;
  weights?: Record<string, unknown>;
  [key: string]: unknown;
}

const cache = new Map<string, { at: number; result: RankResult }>();

export async function rankPairs(query: RankQuery = {}): Promise<RankResult> {
  const cfg = mergeScalpConfig(query);
  const cacheKey = JSON.stringify({ q: query });
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < cfg.cacheTtlMs) return hit.result;

  const now = Date.now();
  const wantMarket = (query.market ?? "all").toUpperCase();
  const wantQuote = (query.quote ?? "all").toUpperCase();
  const wantBase = (query.base ?? "").toUpperCase().trim();
  const minVol = Number(query.minVolumeUsd) || 0;

  const sources = configuredSources().filter(
    (s) => (!query.exchange || s.exchange === query.exchange.toUpperCase()) &&
           (wantMarket === "ALL" || s.marketType === wantMarket),
  );

  const pairs: PairRank[] = [];
  let irtPerUsd: number | null = null;
  let totalPairs = 0;

  for (const src of sources) {
    const rows = await collectStats(src);
    totalPairs += rows.length;

    // USDT→IRT reference converts IRT volumes/depths to USD for cross-quote ranking
    const usdtIrt = rows.find((r) => r.symbol === "USDTIRT");
    if (usdtIrt && usdtIrt.last > 0) irtPerUsd = usdtIrt.last;

    const filtered = rows.filter(
      (r) => (!wantBase || r.baseCurrency.includes(wantBase)) &&
             (wantQuote === "ALL" || r.quoteCurrency === wantQuote),
    );

    // enrichment budget goes to the most liquid pairs first
    const volUsd = (r: (typeof rows)[number]) =>
      r.quoteCurrency === "USDT" ? r.volumeQuote24h
        : irtPerUsd ? r.volumeQuote24h / irtPerUsd : 0;
    const byLiquidity = [...filtered].sort((a, b) => volUsd(b) - volUsd(a));
    const enriched = new Set(byLiquidity.slice(0, cfg.bookLimit).map((r) => r.symbol));

    const snapshots = await mapPool(filtered, cfg.concurrency, (r) =>
      buildSnapshot(src, r, enriched.has(r.symbol), cfg, now),
    );

    for (const snap of snapshots) {
      const ranked = scorePair(snap, cfg, { orderSizeUsd: cfg.orderSizeUsd, irtPerUsd, now });
      if (minVol > 0 && ranked.status === "RANKED" &&
          (ranked.metrics.volumeUsd24h ?? 0) < minVol) continue;
      pairs.push(ranked);
    }
  }

  pairs.sort((a, b) => rankOrder(a) - rankOrder(b) || (b.score ?? -1) - (a.score ?? -1));

  const result: RankResult = {
    pairs,
    meta: {
      generatedAt: now,
      source: sources.map((s) => `${s.exchange}/${s.marketType}`).join(", ") || "—",
      totalPairs,
      ranked: pairs.filter((p) => p.status === "RANKED").length,
      partial: pairs.filter((p) => p.status === "RANKED" && p.partial).length,
      excluded: pairs.filter((p) => p.status === "EXCLUDED").length,
      noData: pairs.filter((p) => p.status === "NO_DATA").length,
      usdIrtRate: irtPerUsd,
      disclaimer:
        "رتبه‌بندی صرفاً بر اساس داده‌های بازار و معیارهای انتخاب‌شده است و سودآوری را تضمین نمی‌کند.",
    },
  };
  if (!query.includeExcluded) result.pairs = pairs.filter((p) => p.status === "RANKED");

  cache.set(cacheKey, { at: now, result });
  if (cache.size > 50) for (const k of [...cache.keys()].slice(0, 20)) cache.delete(k);
  return result;
}

async function collectStats(src: MarketDataSource) {
  try {
    return await src.getMarketStats();
  } catch {
    logger.error("scalping stats failed", { module: "scalping", exchange: src.exchange });
    throw new AppError("EXCHANGE_CONNECTION_FAILED", 502, { exchange: src.exchange });
  }
}

async function buildSnapshot(
  src: MarketDataSource,
  r: Awaited<ReturnType<MarketDataSource["getMarketStats"]>>[number],
  enrich: boolean,
  cfg: ScalpConfig,
  now: number,
): Promise<PairSnapshot> {
  const snap: PairSnapshot = {
    symbol: r.symbol,
    baseCurrency: r.baseCurrency,
    quoteCurrency: r.quoteCurrency,
    exchange: src.exchange,
    marketType: src.marketType,
    stats: r,
    statsTs: r.ts,
  };
  if (!enrich || r.isClosed) return snap;

  const [book, candles, funding, oi] = await Promise.all([
    src.getOrderBook(r.symbol).catch(() => null),
    src.getCandles(r.symbol, cfg.candleTimeframe, cfg.candleLookback).catch(() => null),
    src.getFundingInfo ? src.getFundingInfo(r.symbol).catch(() => null) : Promise.resolve(null),
    src.getOpenInterest ? src.getOpenInterest(r.symbol).catch(() => null) : Promise.resolve(null),
  ]);
  if (book) {
    snap.book = book;
    snap.bookTs = book.ts;
  }
  if (candles?.length) {
    snap.candles = candles;
    snap.candleAgeMs = now - candles[candles.length - 1].time;
  }
  if (funding) snap.funding = funding;
  if (oi !== null) snap.openInterestUsd = oi;
  return snap;
}

function rankOrder(p: PairRank): number {
  return p.status === "RANKED" ? 0 : p.status === "EXCLUDED" ? 1 : 2;
}

/** bounded parallel map — keeps us inside the exchange rate limiter budget */
async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}
