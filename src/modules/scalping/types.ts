import type { OrderBook, Candle } from "@/modules/exchanges/types";
import type { ScalpWeights } from "./config";

export type MarketType = "SPOT" | "PERPETUAL";
export type RankStatus = "RANKED" | "EXCLUDED" | "NO_DATA";

/** One market's raw stats row as normalized from the exchange bulk endpoint. */
export interface MarketStatsRow {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  last: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  change24hPct: number;
  /** 24h volume in quote currency (IRT/USDT) */
  volumeQuote24h: number;
  isClosed: boolean;
  ts: number;
}

/** Everything collected for one pair before scoring. */
export interface PairSnapshot {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  exchange: string;
  marketType: MarketType;
  stats?: MarketStatsRow;
  book?: OrderBook;
  candles?: Candle[];
  /** perpetuals only — null when the exchange exposes none (Nobitex margin is not perpetual) */
  fundingRate?: number | null;
  statsTs?: number;
  bookTs?: number;
  /** age of the newest candle relative to now */
  candleAgeMs?: number;
}

export interface PairMetrics {
  mid?: number;
  spreadPct?: number | null;
  volumeUsd24h?: number | null;
  depthUsd?: number | null;         // quote depth within ±band, converted to USD
  slippageBuyPct?: number | null;   // walking asks for orderSizeUsd
  slippageSellPct?: number | null;  // walking bids
  slippagePct?: number | null;      // mean of both legs
  volatilityPct?: number | null;    // std of per-candle log returns
  volatilityEstimated?: boolean;    // true when 24h range used instead of candles
  dayRangePct?: number | null;
  roundTripCostPct?: number | null; // slipBuy + slipSell + 2×fee
  feePctPerSide?: number;
}

export interface CriterionScore {
  key: keyof ScalpWeights;
  label: string;
  raw: number | null;
  unit: string;
  score: number | null;   // 0..100
  weight: number;         // effective weight actually used
  note?: string;
}

export interface PairRank {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  exchange: string;
  marketType: MarketType;
  status: RankStatus;
  score: number | null;
  partial: boolean;           // scored on a subset of criteria (weights renormalized)
  reasons: string[];          // Persian, user-facing
  criteria: CriterionScore[];
  metrics: PairMetrics;
  dataQuality: {
    completeness: number;     // 0..1 fraction of criteria with valid data
    stale: string[];          // stale feed names
    issues: string[];         // Persian notes
  };
  updatedAt: number;
}

export interface RankMeta {
  generatedAt: number;
  source: string;
  totalPairs: number;
  ranked: number;
  partial: number;
  excluded: number;
  noData: number;
  usdIrtRate: number | null;  // USDT→IRT used for USD normalization
  disclaimer: string;
}

export interface RankResult {
  pairs: PairRank[];
  meta: RankMeta;
}

/**
 * Swappable market-data port — add a new exchange by implementing this and
 * registering it in dataSourceFor(). No trading methods exist here by design.
 */
export interface MarketDataSource {
  readonly exchange: string;
  readonly marketType: MarketType;
  /** bulk ticker stats for every listed market (one request) */
  getMarketStats(): Promise<MarketStatsRow[]>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  /** funding rate for perpetuals; null when the venue has none */
  getFundingRate?(symbol: string): Promise<number | null>;
}
