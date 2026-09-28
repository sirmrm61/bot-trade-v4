import { publicAdapter } from "@/modules/exchanges/registry";
import { KucoinAdapter } from "@/modules/exchanges/kucoin";
import type { Candle, OrderBook } from "@/modules/exchanges/types";
import type { FundingInfo, MarketDataSource, MarketStatsRow } from "./types";

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
        markPrice: num(s.mark) || undefined,
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
  async getFundingInfo() {
    return null;
  }

  /** No public open-interest endpoint on Nobitex. */
  async getOpenInterest() {
    return null;
  }
}

/**
 * KuCoin spot — /api/v1/market/allTickers carries per-market maker/taker fee
 * rates, so scalping costs here are the venue's real fees, not config defaults.
 */
export class KucoinSpotDataSource implements MarketDataSource {
  readonly exchange = "KUCOIN";
  readonly marketType = "SPOT" as const;
  private adapter = new KucoinAdapter({ apiKey: "" });

  async getMarketStats(): Promise<MarketStatsRow[]> {
    const data = await this.adapter.publicGet<{ data?: { ticker?: Record<string, unknown>[] } }>(
      "/api/v1/market/allTickers");
    const ts = Date.now();
    return (data.data?.ticker ?? []).map((t) => ({
      symbol: String(t.symbol ?? ""),
      baseCurrency: String(t.symbol ?? "").split("-")[0] ?? "",
      quoteCurrency: String(t.symbol ?? "").split("-")[1] ?? "",
      last: num(t.last),
      bid: num(t.buy),
      ask: num(t.sell),
      high24h: num(t.high),
      low24h: num(t.low),
      change24hPct: num(t.changeRate) * 100,
      volumeQuote24h: num(t.volValue),
      takerFeePct: num(t.takerFeeRate) * 100,
      makerFeePct: num(t.makerFeeRate) * 100,
      isClosed: false,
      ts,
    })).filter((r) => r.symbol);
  }

  getOrderBook(symbol: string): Promise<OrderBook> {
    return this.adapter.getOrderBook(symbol);
  }

  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    return this.adapter.getCandles(symbol, timeframe, undefined, limit);
  }
}

/**
 * KuCoin perpetuals — contracts/active carries funding (current + predicted +
 * settlement time), open interest, mark/index and max leverage — the first
 * source where perpetual metrics are real.
 */
export class KucoinPerpDataSource implements MarketDataSource {
  readonly exchange = "KUCOIN";
  readonly marketType = "PERPETUAL" as const;
  private adapter = new KucoinAdapter({ apiKey: "" });
  private contracts = new Map<string, Record<string, unknown>>();

  async getMarketStats(): Promise<MarketStatsRow[]> {
    const contracts = await this.adapter.listFuturesContracts();
    this.contracts = new Map(contracts.map((c) => [String(c.symbol ?? "").toUpperCase(), c]));
    const ts = Date.now();
    return contracts.map((c) => ({
      symbol: String(c.symbol ?? ""),
      baseCurrency: String(c.baseCurrency ?? ""),
      quoteCurrency: String(c.quoteCurrency ?? c.settleCurrency ?? "USDT"),
      last: num(c.lastTradePrice) || num(c.indexPrice),
      bid: 0, // books arrive per-symbol on enrichment — ticker stage has no bid/ask
      ask: 0,
      high24h: num(c.highPrice),
      low24h: num(c.lowPrice),
      change24hPct: num(c.priceChgPct) * 100,
      volumeQuote24h: num(c.turnoverOf24h),
      markPrice: num(c.markPrice) || undefined,
      takerFeePct: num(c.takerFeeRate) * 100,
      makerFeePct: num(c.makerFeeRate) * 100,
      isClosed: String(c.status ?? "") !== "Open",
      ts,
    })).filter((r) => r.symbol);
  }

  getOrderBook(symbol: string): Promise<OrderBook> {
    return this.adapter.getFuturesOrderBook(symbol);
  }

  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    return this.adapter.getFuturesCandles(symbol, timeframe, undefined, limit);
  }

  async getFundingInfo(symbol: string): Promise<FundingInfo | null> {
    const c = this.contracts.get(symbol.toUpperCase())
      ?? await this.fetchContract(symbol);
    if (!c) return null;
    const rate = num(c.fundingFeeRate ?? c.fundingRate);
    // nextFundingRateTime is ms *remaining*; nextFundingRateDateTime is the epoch
    const settleAt = num(c.nextFundingRateDateTime) || undefined;
    return {
      rate: rate * 100, // fraction → %
      nextRate: c.predictedFundingFeeRate != null ? num(c.predictedFundingFeeRate) * 100 : undefined,
      nextSettlementTs: settleAt,
    };
  }

  /** OI (contracts) × multiplier × mark price → USD value. */
  async getOpenInterest(symbol: string): Promise<number | null> {
    const c = this.contracts.get(symbol.toUpperCase())
      ?? await this.fetchContract(symbol);
    if (!c) return null;
    const oi = num(c.openInterest);
    const mult = num(c.multiplier) || 1;
    const mark = num(c.markPrice) || num(c.indexPrice);
    if (!oi || !mark) return null;
    return oi * mult * mark;
  }

  private async fetchContract(symbol: string): Promise<Record<string, unknown> | null> {
    try {
      const list = await this.adapter.listFuturesContracts();
      const c = list.find((x) => String(x.symbol ?? "").toUpperCase() === symbol.toUpperCase());
      if (c) this.contracts.set(symbol.toUpperCase(), c);
      return c ?? null;
    } catch {
      return null;
    }
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const SOURCES: Record<string, () => MarketDataSource> = {
  NOBITEX: () => new NobitexDataSource(),
  "KUCOIN:SPOT": () => new KucoinSpotDataSource(),
  "KUCOIN:PERPETUAL": () => new KucoinPerpDataSource(),
};

/** Configured exchanges only — returns null for anything else (never fabricates).
 *  `marketType` picks a sub-source when an exchange has several (KUCOIN perp). */
export function dataSourceFor(exchange: string, marketType?: string): MarketDataSource | null {
  const ex = exchange.toUpperCase();
  const mt = marketType?.toUpperCase();
  const keyed = mt && mt !== "ALL" ? SOURCES[`${ex}:${mt}`]?.() : undefined;
  return keyed ?? SOURCES[ex]?.() ?? SOURCES[`${ex}:SPOT`]?.() ?? null;
}

export function configuredSources(): MarketDataSource[] {
  return Object.values(SOURCES).map((f) => f());
}
