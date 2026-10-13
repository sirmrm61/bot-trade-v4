import { publicAdapter } from "@/modules/exchanges/registry";
import { ema, atr, sma } from "@/modules/indicators/engine";
import { faNumber } from "@/shared/utils";
import type { Candle } from "@/modules/exchanges/types";
import type { SignalMakerConfig } from "@/generated/prisma/client";

/**
 * BTC market context — trend vs EMA20/50/200 on the reference timeframe (4h)
 * and 1d, plus a volatility regime from ATR vs its own average. The composite
 * regime (AGGRESSIVE | NEUTRAL | DEFENSIVE) steers setup scoring; on FUTURES
 * the adapter's contract stats add funding rate + open interest when exposed.
 */

export type Trend = "UP" | "DOWN" | "RANGE";
export type Volatility = "LOW" | "NORMAL" | "HIGH";
export type MarketRegime = "AGGRESSIVE" | "NEUTRAL" | "DEFENSIVE";

export interface MarketContext {
  exchange: string;
  marketType: string;
  symbol: string;
  price: number;
  trendRef: Trend;              // reference tf (4h)
  trend1d: Trend;
  volatility: Volatility;
  atrPct: number;               // ATR14 / price % on ref tf
  regime: MarketRegime;
  summaryFa: string;
  fundingRatePct: number | null;
  openInterestUsd: number | null;
  scannedAt: number;
  /** internal — ref-tf BTC candles reused by the scanner for relative strength;
   *  stripped before the API response */
  refCandles?: Candle[];
}

type ContractStatAdapter = {
  listFuturesContracts?: () => Promise<Record<string, unknown>[]>;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Resolve the BTC market symbol for this venue/market. */
export async function btcSymbol(
  exchange: string,
  quote: string,
  marketType: string,
): Promise<string> {
  const ex = exchange.toUpperCase();
  if (ex === "NOBITEX") return `BTC${quote.toUpperCase()}`;
  if (ex === "KUCOIN" && marketType === "FUTURES") {
    try {
      const adapter = publicAdapter(ex) as ContractStatAdapter;
      const contracts = await adapter.listFuturesContracts?.() ?? [];
      const btc = contracts.find(
        (c) => String(c.baseCurrency ?? "").toUpperCase() === "BTC" && String(c.status ?? "Open") === "Open",
      );
      if (btc?.symbol) return String(btc.symbol).toUpperCase();
    } catch { /* fall through to the default */ }
    return "XBTUSDTM";
  }
  return `BTC-${quote.toUpperCase()}`;
}

/** Trend vs EMA20/50/200 on the last close. */
export function trendOf(candles: Candle[]): Trend {
  if (candles.length < 30) return "RANGE";
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1)!;
  const e20 = ema(closes, 20).at(-1)!;
  const e50 = ema(closes, 50).at(-1)!;
  const e200 = closes.length >= 60 ? ema(closes, 200).at(-1)! : NaN;
  const above = [e20, e50, e200].filter((e) => Number.isFinite(e) && price > e).length;
  const aligned = Number.isFinite(e50) && e20 > e50;
  if (above >= 2 && aligned) return "UP";
  if (above <= 1 && Number.isFinite(e50) && e20 < e50) return "DOWN";
  return "RANGE";
}

/** ATR14 relative to its own 20-SMA — vol expansion/contraction regime. */
export function volatilityOf(candles: Candle[]): { volatility: Volatility; atrPct: number } {
  const a = atr(candles, 14);
  const atrNow = a.at(-1) ?? NaN;
  const price = candles.at(-1)?.close ?? 0;
  const atrPct = Number.isFinite(atrNow) && price > 0 ? (atrNow / price) * 100 : 0;
  const atrAvg = sma(a.map((v) => (Number.isFinite(v) ? v : 0)), 20).at(-1) ?? NaN;
  const ratio = Number.isFinite(atrAvg) && atrAvg > 0 ? atrNow / atrAvg : 1;
  return { atrPct, volatility: ratio > 1.3 ? "HIGH" : ratio < 0.75 ? "LOW" : "NORMAL" };
}

export function regimeOf(trendRef: Trend, trend1d: Trend, volatility: Volatility): MarketRegime {
  if (trend1d === "DOWN" || (trendRef === "DOWN" && volatility === "HIGH")) return "DEFENSIVE";
  if (trendRef === "UP" && trend1d === "UP" && volatility !== "HIGH") return "AGGRESSIVE";
  return "NEUTRAL";
}

const TREND_FA: Record<Trend, string> = { UP: "صعودی", DOWN: "نزولی", RANGE: "رنج" };
const VOL_FA: Record<Volatility, string> = { LOW: "کم", NORMAL: "متعارف", HIGH: "بالا" };
export const REGIME_FA: Record<MarketRegime, string> = {
  AGGRESSIVE: "تهاجمی", NEUTRAL: "خنثی", DEFENSIVE: "دفاعی",
};

/**
 * Build the BTC context for a config. Funding/OI are included only on FUTURES
 * when the adapter exposes contract stats (KuCoin contracts/active).
 */
export async function marketContext(
  cfg: Pick<SignalMakerConfig, "exchange" | "marketType" | "quote"> & { timeframe?: string },
): Promise<MarketContext> {
  const exchange = cfg.exchange.toUpperCase();
  const adapter = publicAdapter(exchange);
  const refTf = cfg.timeframe ?? "4h";
  const symbol = await btcSymbol(exchange, cfg.quote, cfg.marketType);

  const [ref, d1] = await Promise.all([
    adapter.getCandles(symbol, refTf, undefined, 300),
    adapter.getCandles(symbol, "1d", undefined, 260),
  ]);
  const price = ref.at(-1)?.close ?? 0;
  const trendRef = trendOf(ref);
  const trend1d = trendOf(d1);
  const { volatility, atrPct } = volatilityOf(ref);
  let regime = regimeOf(trendRef, trend1d, volatility);

  // perpetual extras — feature-detected, never fabricated
  let fundingRatePct: number | null = null;
  let openInterestUsd: number | null = null;
  if (cfg.marketType === "FUTURES") {
    try {
      const contracts = await (adapter as ContractStatAdapter).listFuturesContracts?.() ?? [];
      const c = contracts.find((x) => String(x.symbol ?? "").toUpperCase() === symbol);
      if (c) {
        const f = num(c.fundingFeeRate ?? c.fundingRate);
        if (f) fundingRatePct = f * 100;
        const oi = num(c.openInterest) * (num(c.multiplier) || 1) * (num(c.markPrice) || num(c.indexPrice));
        if (oi > 0) openInterestUsd = oi;
      }
    } catch { /* funding unavailable — context still valid */ }
    // extreme funding = crowded positioning → cap the regime
    if (fundingRatePct !== null && Math.abs(fundingRatePct) > 0.1 && regime === "AGGRESSIVE") {
      regime = "NEUTRAL";
    }
  }

  const parts = [
    `BTC (${symbol}) در ${refTf} ${TREND_FA[trendRef]}، در روزانه ${TREND_FA[trend1d]}`,
    `نوسان ${VOL_FA[volatility]} (ATR ${faNumber(atrPct, true)}٪)`,
    `رژیم کلی: ${REGIME_FA[regime]}`,
  ];
  if (fundingRatePct !== null) parts.push(`فاندینگ ${faNumber(fundingRatePct, true)}٪`);

  return {
    exchange, marketType: cfg.marketType, symbol, price,
    trendRef, trend1d, volatility, atrPct, regime,
    summaryFa: parts.join(" · "),
    fundingRatePct, openInterestUsd,
    scannedAt: Date.now(),
    refCandles: ref,
  };
}
