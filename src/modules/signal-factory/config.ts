import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { parseJson } from "@/shared/utils";
import { EXCHANGE_IDS, SIGNAL_TIMEFRAMES } from "@/shared/constants";
import type { Pair, SignalMakerConfig } from "@/generated/prisma/client";

/**
 * Signal factory config — one row per user, created on first access.
 * Drives which exchange/market the setup scanner reads and which pairs qualify.
 */

export const SIGNAL_EXCHANGES = EXCHANGE_IDS;
export const MARKET_TYPES = ["SPOT", "FUTURES"] as const;
export const SCAN_TIMEFRAMES = SIGNAL_TIMEFRAMES;
export const DEFAULT_TIMEFRAMES = ["4h", "1h", "1d"];

export function getOrCreateConfig(userId: string) {
  return prisma.signalMakerConfig.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export function configTimeframes(cfg: Pick<SignalMakerConfig, "timeframes">): string[] {
  const tfs = parseJson<string[]>(cfg.timeframes, DEFAULT_TIMEFRAMES);
  return tfs.length ? tfs : DEFAULT_TIMEFRAMES;
}

export interface SignalConfigInput {
  exchange?: string;
  marketType?: string;
  quote?: string;
  minVolume24h?: number;
  timeframes?: string[];
  scanEveryHours?: number;
  enabled?: boolean;
  liveTradingEnabled?: boolean;
}

export async function updateConfig(userId: string, input: SignalConfigInput) {
  const cfg = await getOrCreateConfig(userId);
  const data: Record<string, unknown> = {};

  if (input.exchange !== undefined) {
    const exchange = input.exchange.toUpperCase();
    if (!SIGNAL_EXCHANGES.includes(exchange as never)) {
      throw new AppError("VALIDATION", 400, { exchange }, "صرافی باید NOBITEX یا KUCOIN باشد");
    }
    data.exchange = exchange;
  }
  if (input.marketType !== undefined) {
    const marketType = input.marketType.toUpperCase();
    if (!MARKET_TYPES.includes(marketType as never)) {
      throw new AppError("VALIDATION", 400, { marketType }, "نوع بازار باید SPOT یا FUTURES باشد");
    }
    data.marketType = marketType;
  }
  if (input.quote !== undefined) {
    const quote = input.quote.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(quote)) {
      throw new AppError("VALIDATION", 400, { quote }, "ارز پایه (quote) نامعتبر است");
    }
    data.quote = quote;
  }
  if (input.minVolume24h !== undefined) {
    if (!Number.isFinite(input.minVolume24h) || input.minVolume24h < 0) {
      throw new AppError("VALIDATION", 400, {}, "حداقل حجم ۲۴ ساعته نامعتبر است");
    }
    data.minVolume24h = input.minVolume24h;
  }
  if (input.scanEveryHours !== undefined) {
    const h = Math.floor(input.scanEveryHours);
    if (!Number.isFinite(h) || h < 1 || h > 168) {
      throw new AppError("VALIDATION", 400, {}, "دوره‌ی اسکن باید بین ۱ تا ۱۶۸ ساعت باشد");
    }
    data.scanEveryHours = h;
  }
  if (input.timeframes !== undefined) {
    const tfs = input.timeframes.filter((t) => (SCAN_TIMEFRAMES as readonly string[]).includes(t));
    if (!tfs.length || tfs.length !== input.timeframes.length) {
      throw new AppError("INVALID_TIMEFRAME", 400, { timeframes: input.timeframes });
    }
    data.timeframes = JSON.stringify(tfs);
  }
  if (input.enabled !== undefined) data.enabled = input.enabled === true;
  if (input.liveTradingEnabled !== undefined) data.liveTradingEnabled = input.liveTradingEnabled === true;

  return prisma.signalMakerConfig.update({ where: { id: cfg.id }, data });
}

/**
 * 24h volume read from the synced pair metadata — each adapter keeps the raw
 * exchange payload in Pair.metadata (nobitex stats: volumeSrc/dayVolume,
 * kucoin symbols payload fields). Returns 0 when absent → the pair only passes
 * the liquidity filter while minVolume24h is 0.
 */
const VOLUME_KEYS = [
  "volume24h", "vol", "volValue", "volCurrencyValue",
  "volumeSrc", "dayVolume", "quoteVolume", "turnover24h",
];

export function pairVolume24h(pair: Pick<Pair, "metadata">): number {
  const raw = parseJson<Record<string, unknown>>(pair.metadata, {});
  for (const k of VOLUME_KEYS) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * Candidate pairs for the scanner: active markets on the configured exchange
 * whose quote currency matches, filtered by the 24h liquidity floor.
 */
export async function pairFilter(
  cfg: Pick<SignalMakerConfig, "exchange" | "quote" | "minVolume24h">,
  pairs?: Pick<Pair, "exchange" | "symbol" | "quoteCurrency" | "active" | "metadata">[],
) {
  const all =
    pairs ??
    (await prisma.pair.findMany({
      where: { exchange: cfg.exchange, quoteCurrency: cfg.quote, active: true },
    }));
  return all.filter(
    (p) =>
      p.exchange === cfg.exchange &&
      p.quoteCurrency === cfg.quote &&
      p.active &&
      pairVolume24h(p) >= cfg.minVolume24h,
  );
}
