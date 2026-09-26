import { prisma } from "@/infrastructure/database/prisma";
import { publicAdapter } from "@/modules/exchanges/registry";
import { logger } from "@/infrastructure/logging/logger";

/**
 * Pair synchronization — periodic worker:
 *   Fetch Nobitex Markets → Validate → Upsert → Deactivate removed markets
 */
export async function syncPairs(exchange = "NOBITEX") {
  const adapter = publicAdapter();
  const markets = await adapter.getMarkets();
  const seen = new Set<string>();
  let upserted = 0;

  for (const m of markets) {
    if (!m.symbol || !m.baseCurrency || !m.quoteCurrency) continue;
    seen.add(m.symbol);
    await prisma.pair.upsert({
      where: { symbol: m.symbol },
      create: {
        symbol: m.symbol,
        baseCurrency: m.baseCurrency,
        quoteCurrency: m.quoteCurrency,
        minAmount: m.minAmount,
        maxAmount: m.maxAmount,
        minPrice: m.minPrice,
        maxPrice: m.maxPrice,
        amountPrecision: m.amountPrecision,
        pricePrecision: m.pricePrecision,
        active: m.active,
        tradingStatus: m.active ? "ACTIVE" : "DISABLED",
        exchange,
        metadata: m.raw ? JSON.stringify(m.raw) : null,
        syncedAt: new Date(),
      },
      update: {
        baseCurrency: m.baseCurrency,
        quoteCurrency: m.quoteCurrency,
        minAmount: m.minAmount,
        maxAmount: m.maxAmount,
        minPrice: m.minPrice,
        maxPrice: m.maxPrice,
        active: m.active,
        tradingStatus: m.active ? "ACTIVE" : "DISABLED",
        metadata: m.raw ? JSON.stringify(m.raw) : null,
        syncedAt: new Date(),
      },
    });
    upserted++;
  }

  // deactivate markets that disappeared from the exchange
  const deactivated = await prisma.pair.updateMany({
    where: { exchange, symbol: { notIn: [...seen] }, active: true },
    data: { active: false, tradingStatus: "DELISTED" },
  });

  logger.info("pairs synced", { module: "pairs", upserted, deactivated: deactivated.count });
  return { upserted, deactivated: deactivated.count };
}

/** Candle cache — read-through into historical_candles. */
export async function getCandles(opts: {
  symbol: string;
  timeframe: string;
  start: Date;
  end: Date;
}) {
  const cached = await prisma.historicalCandle.findMany({
    where: {
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      time: { gte: opts.start, lte: opts.end },
    },
    orderBy: { time: "asc" },
  });

  // coverage check — if cache covers the range (±5%), use it
  const expected = (opts.end.getTime() - opts.start.getTime()) / tfMs(opts.timeframe);
  if (cached.length >= expected * 0.95 && cached.length > 10) {
    return cached.map((c) => ({
      time: c.time.getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
  }

  const adapter = publicAdapter();
  const needed = Math.ceil((opts.end.getTime() - opts.start.getTime()) / tfMs(opts.timeframe)) + 10;
  const candles = await adapter.getCandles(opts.symbol, opts.timeframe, opts.start.getTime(), Math.max(needed, 500), opts.end.getTime());
  const filtered = candles.filter((c) => c.time >= opts.start.getTime() && c.time <= opts.end.getTime());

  // upsert into cache — skipDuplicates keeps it idempotent
  if (filtered.length) {
    // skip already-cached timestamps — createMany+skipDuplicates unsupported on sqlite adapter
    const existing = new Set(
      (await prisma.historicalCandle.findMany({
        where: { symbol: opts.symbol, timeframe: opts.timeframe, time: { gte: new Date(filtered[0].time), lte: new Date(filtered[filtered.length - 1].time) } },
        select: { time: true },
      })).map((r) => r.time.getTime()),
    );
    const fresh = filtered.filter((c) => !existing.has(c.time));
    if (fresh.length) {
      await prisma.historicalCandle.createMany({
        data: fresh.map((c) => ({
          symbol: opts.symbol,
          timeframe: opts.timeframe,
          time: new Date(c.time),
          open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        })),
      }).catch(() => {});
    }
  }
  return filtered;
}

export function tfMs(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
    "4h": 14_400_000, "1d": 86_400_000,
  };
  return map[tf] ?? 3_600_000;
}
