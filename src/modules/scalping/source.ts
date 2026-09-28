import { publicAdapter } from "@/modules/exchanges/registry";
import type { Candle, OrderBook } from "@/modules/exchanges/types";
import type { MarketDataSource, MarketStatsRow } from "./types";

/**
 * MarketDataSource implementations — each exchange normalizes its bulk stats,
 * order book and candles into the common internal shape here.
 */

export class NobitexDataSource implements MarketDataSource {
  readonly exchange = "NOBITEX";
  readonly marketType = "SPOT" as const;

  async getMarketStats(): Promise<MarketStatsRow[]> {
    const markets = await publicAdapter().getMarkets();
    const ts = Date.now();
    const rows: MarketStatsRow[] = [];
    for (const m of markets) {
      const s = (m.raw ?? {}) as Record<string, unknown>;
      rows.push({
        symbol: m.symbol,
        baseCurrency: m.baseCurrency,
        quoteCurrency: m.quoteCurrency,
        last: num(s.latest),
        bid: num(s.bestBuy),
        ask: num(s.bestSell),
        high24h: num(s.dayHigh),
        low24h: num(s.dayLow),
        change24hPct: num(s.dayChange),
        volumeQuote24h: num(s.volumeDst),
        isClosed: Boolean(s.isClosed) || !m.active,
        ts,
      });
    }
    return rows;
  }

  getOrderBook(symbol: string): Promise<OrderBook> {
    return publicAdapter().getOrderBook(symbol);
  }

  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    return publicAdapter().getCandles(symbol, timeframe, undefined, limit);
  }

  /** Nobitex margin is borrow-based, not perpetual — no funding rate exists. */
  async getFundingRate(): Promise<number | null> {
    return null;
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const SOURCES: Record<string, () => MarketDataSource> = {
  NOBITEX: () => new NobitexDataSource(),
};

/** Configured exchanges only — returns null for anything else (never fabricates). */
export function dataSourceFor(exchange: string): MarketDataSource | null {
  return SOURCES[exchange.toUpperCase()]?.() ?? null;
}

export function configuredSources(): MarketDataSource[] {
  return Object.values(SOURCES).map((f) => f());
}
