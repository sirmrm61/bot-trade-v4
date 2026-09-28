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
  /** mark/index reference price when the venue publishes one (Nobitex stats include `mark`) */
  markPrice?: number;
  /** real per-market taker fee % when the venue publishes it (KuCoin allTickers) */
  takerFeePct?: number;
  /** real per-market maker fee % */
  makerFeePct?: number;
  isClosed: boolean;
  ts: number;
}

/** Perpetual-futures funding info — null/omitted on venues without perpetuals. */
export interface FundingInfo {
  rate: number;          // current funding rate, % per settlement
  nextRate?: number;     // predicted next rate when the venue publishes it
  nextSettlementTs?: number; // epoch ms of next settlement → countdown
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
  funding?: FundingInfo | null;
  openInterestUsd?: number | null;
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
  roundTripCostPct?: number | null; // cost-mode dependent — see costMode
  feePctPerSide?: number;           // taker fee used
  makerFeePct?: number;

  // perpetual / leverage metrics
  costMode?: "TAKER" | "MAKER" | "MIXED";
  leverage?: number;
  marginUsd?: number;               // hypothetical margin (user-chosen)
  notionalUsd?: number;             // marginUsd × leverage — actual position value
  breakEvenMovePct?: number | null; // price move needed to cover round-trip cost
  breakEvenMarginPct?: number | null; // same move expressed on margin (cost × leverage)
  markPrice?: number;
  markLastGapPct?: number | null;   // |mark − last| % — stop/liquidation slippage risk
  fundingRate?: number | null;      // % per settlement
  fundingNextRate?: number | null;
  fundingCountdownMs?: number | null;
  openInterestUsd?: number | null;
  volToOi?: number | null;          // volume24h / OI — exit-liquidity gauge
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
  /** funding info for perpetuals; null/absent when the venue has none */
  getFundingInfo?(symbol: string): Promise<FundingInfo | null>;
  /** open interest in USD for perpetuals; null/absent when the venue has none */
  getOpenInterest?(symbol: string): Promise<number | null>;
}
