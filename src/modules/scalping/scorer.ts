import { clamp, faNumber } from "@/shared/utils";
import { tfMs } from "@/modules/pairs/service";
import {
  type ScalpConfig,
  CRITERION_LABELS,
  CRITERION_KEYS,
  type ScalpWeights,
} from "./config";
import {
  midPrice,
  spreadPct,
  bookDepthQuote,
  walkBook,
  realizedVolPct,
  dayRangePct,
} from "./metrics";
import type { PairSnapshot, PairRank, PairMetrics, CriterionScore } from "./types";

/**
 * scorePair — pure function: snapshot + config → ranked row.
 * Scoring maps each raw metric to 0..100 against explainable reference points,
 * then weights renormalize over the criteria that actually have data.
 */

const PCT = "٪";
const USD = "$";

/** log curve: min→0, ref→100 */
function logScore(value: number, min: number, ref: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || !(ref > min)) return null;
  const lo = Math.max(min, 1e-9);
  return clamp((Math.log(1 + value / lo) / Math.log(1 + ref / lo)) * 100, 0, 100);
}

/** inverse linear: 0→100, badRef→0 */
function inverseScore(value: number, badRef: number): number | null {
  if (!Number.isFinite(value) || !(badRef > 0)) return null;
  return clamp((1 - value / badRef) * 100, 0, 100);
}

export function scorePair(
  snap: PairSnapshot,
  cfg: ScalpConfig,
  ctx: { orderSizeUsd: number; irtPerUsd: number | null; now: number },
): PairRank {
  const reasons: string[] = [];
  const issues: string[] = [];
  const stale: string[] = [];

  const toUsd = (quoteAmount: number): number | null =>
    snap.quoteCurrency === "USDT"
      ? quoteAmount
      : ctx.irtPerUsd ? quoteAmount / ctx.irtPerUsd : null;

  const fromUsd = (usd: number): number | null =>
    snap.quoteCurrency === "USDT"
      ? usd
      : ctx.irtPerUsd ? usd * ctx.irtPerUsd : null;

  const s = snap.stats;
  const metrics: PairMetrics = { feePctPerSide: cfg.feePctPerSide };

  // ---------- extract raw metrics ----------
  let bid = s?.bid ?? 0;
  let ask = s?.ask ?? 0;
  let bookUsable = false;

  if (snap.book) {
    const bookAge = ctx.now - (snap.bookTs ?? snap.book.ts);
    if (bookAge > cfg.maxBookStaleMs) {
      stale.push("orderbook");
      issues.push("دفتر سفارش قدیمی است — معیارهای عمق و لغزش لحاظ نشد");
    } else {
      bookUsable = true;
      // freshest quotes win
      if (snap.book.bids[0]?.[0] && snap.book.asks[0]?.[0]) {
        bid = snap.book.bids[0][0];
        ask = snap.book.asks[0][0];
      }
    }
  }

  const mid = midPrice(bid, ask);
  metrics.mid = mid ?? undefined;
  metrics.spreadPct = mid !== null ? spreadPct(bid, ask) : null;
  metrics.volumeUsd24h = s && s.volumeQuote24h > 0 ? toUsd(s.volumeQuote24h) : null;
  if (s && metrics.volumeUsd24h === null && s.volumeQuote24h > 0) {
    issues.push("نرخ تبدیل برای محاسبه حجم دلاری در دسترس نیست");
  }
  metrics.dayRangePct = s && mid !== null ? dayRangePct(s.high24h, s.low24h, mid) : null;

  if (bookUsable && mid !== null) {
    metrics.depthUsd = toUsd(bookDepthQuote(snap.book!, mid, cfg.depthBandPct));
    const notional = fromUsd(ctx.orderSizeUsd);
    if (notional !== null) {
      const wb = walkBook(snap.book!, "buy", notional, mid);
      const ws = walkBook(snap.book!, "sell", notional, mid);
      // a book that can't absorb the hypothetical order misleads if we only
      // score the filled slice — treat unfilled legs as worst-case slippage,
      // and hard-fail when most of the order can't fill at all
      const legSlip = (w: ReturnType<typeof walkBook>) => {
        const fillRatio = w.filledQuote / notional;
        if (fillRatio < 0.5) return { slip: w.slippagePct, starved: true };
        if (!w.fullyFilled) return { slip: Math.max(w.slippagePct ?? 0, cfg.slippageRefBadPct), starved: false };
        return { slip: w.slippagePct, starved: false };
      };
      const lb = legSlip(wb);
      const ls = legSlip(ws);
      metrics.slippageBuyPct = lb.slip;
      metrics.slippageSellPct = ls.slip;
      const legs = [lb.slip, ls.slip].filter((v): v is number => v !== null);
      metrics.slippagePct = legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : null;
      if (lb.starved || ls.starved) {
        reasons.push("عمق دفتر سفارش برای اندازه سفارش انتخاب‌شده کافی نیست");
      } else if (!wb.fullyFilled || !ws.fullyFilled) {
        issues.push("بخشی از سفارش فرضی در دفتر پر نمی‌شود — لغزش واقعی بیشتر از برآورد است");
      }
    } else {
      issues.push("بدون نرخ تبدیل، لغزش برای اندازه دلاری قابل محاسبه نیست");
    }
    metrics.roundTripCostPct =
      metrics.slippageBuyPct !== null && metrics.slippageBuyPct !== undefined &&
      metrics.slippageSellPct !== null && metrics.slippageSellPct !== undefined
        ? metrics.slippageBuyPct + metrics.slippageSellPct + 2 * cfg.feePctPerSide
        : null;
  }

  const tfMillis = tfMs(cfg.candleTimeframe);
  let volFromCandles = false;
  if (snap.candles?.length) {
    if (snap.candleAgeMs !== undefined && snap.candleAgeMs > cfg.maxCandleStaleFactor * tfMillis) {
      stale.push("candles");
      issues.push("کندل‌ها قدیمی هستند — نوسان از بازه ۲۴ساعته برآورد شد");
    } else {
      metrics.volatilityPct = realizedVolPct(snap.candles);
      metrics.volatilityEstimated = false;
      volFromCandles = metrics.volatilityPct !== null;
    }
  }
  if (!volFromCandles && metrics.dayRangePct !== null && metrics.dayRangePct !== undefined) {
    metrics.volatilityPct = metrics.dayRangePct;
    metrics.volatilityEstimated = true;
  }

  // ---------- hard gates ----------
  if (!s) {
    return build(snap, "NO_DATA", metrics, [], ["داده‌ی بازار در دسترس نیست"], issues, stale);
  }
  if (s.isClosed || mid === null || !(mid > 0)) {
    return build(snap, "NO_DATA", metrics, [], ["بازار غیرفعال یا قیمت معتبر ندارد"], issues, stale);
  }
  if (metrics.volumeUsd24h !== null && metrics.volumeUsd24h !== undefined && metrics.volumeUsd24h < cfg.hardMinVolumeUsd) {
    reasons.push(`حجم ۲۴ساعته زیر حداقل (${faNumber(cfg.hardMinVolumeUsd)}$)`);
  }
  if (metrics.spreadPct !== null && metrics.spreadPct !== undefined && metrics.spreadPct > cfg.maxSpreadPct) {
    reasons.push(`اسپرد بالاتر از حد مجاز (${faNumber(cfg.maxSpreadPct, true)}٪)`);
  }
  if (metrics.roundTripCostPct !== null && metrics.roundTripCostPct !== undefined && metrics.roundTripCostPct > cfg.maxCostPct) {
    reasons.push(`هزینه رفت‌وبرگشت بالاتر از حد مجاز (${faNumber(cfg.maxCostPct, true)}٪)`);
  }

  // ---------- criteria ----------
  const vol = metrics.volatilityPct;
  const volEstimated = metrics.volatilityEstimated === true;
  const volRef = volEstimated ? cfg.volDayRefPct : cfg.volRefPct;
  const volMin = volEstimated ? 0 : cfg.volMinPct;

  const raws: Record<keyof ScalpWeights, { raw: number | null; unit: string; score: number | null; note?: string }> = {
    liquidity: {
      raw: metrics.volumeUsd24h ?? null,
      unit: USD,
      score: metrics.volumeUsd24h != null ? logScore(metrics.volumeUsd24h, cfg.volumeMinUsd, cfg.volumeRefUsd) : null,
    },
    spread: {
      raw: metrics.spreadPct ?? null,
      unit: PCT,
      score: metrics.spreadPct != null ? inverseScore(metrics.spreadPct, cfg.spreadRefBadPct) : null,
    },
    depth: {
      raw: metrics.depthUsd ?? null,
      unit: USD,
      score: metrics.depthUsd != null ? logScore(metrics.depthUsd, cfg.depthMinUsd, cfg.depthRefUsd) : null,
    },
    slippage: {
      raw: metrics.slippagePct ?? null,
      unit: PCT,
      score: metrics.slippagePct != null ? inverseScore(metrics.slippagePct, cfg.slippageRefBadPct) : null,
    },
    volatility: {
      raw: vol ?? null,
      unit: PCT,
      score:
        vol != null && Number.isFinite(vol)
          ? vol < volMin ? 0 : clamp((vol / volRef) * 100, 0, 100)
          : null,
      note: volEstimated ? "برآورد از بازه ۲۴ساعته (بدون کندل)" : undefined,
    },
    cost: {
      raw: metrics.roundTripCostPct ?? null,
      unit: PCT,
      score: metrics.roundTripCostPct != null ? inverseScore(metrics.roundTripCostPct, cfg.costRefBadPct) : null,
      note: `شامل ${faNumber(cfg.feePctPerSide, true)}٪ کارمزد هر طرف`,
    },
  };

  const criteria: CriterionScore[] = CRITERION_KEYS.map((key) => ({
    key,
    label: CRITERION_LABELS[key],
    raw: raws[key].raw,
    unit: raws[key].unit,
    score: raws[key].score,
    weight: cfg.weights[key],
    note: raws[key].note,
  }));

  const usable = criteria.filter((c) => c.score !== null && c.weight > 0);
  const completeness = criteria.filter((c) => c.score !== null).length / criteria.length;

  if (reasons.length) {
    return build(snap, "EXCLUDED", metrics, criteria, reasons, issues, stale, completeness);
  }
  if (!usable.length || completeness < cfg.minCompleteness) {
    return build(snap, "NO_DATA", metrics, criteria,
      ["داده کافی برای امتیازدهی معتبر وجود ندارد"], issues, stale, completeness);
  }

  const totalW = usable.reduce((t, c) => t + c.weight, 0);
  const score = Math.round(usable.reduce((t, c) => t + c.weight * (c.score ?? 0), 0) / totalW);
  return build(snap, "RANKED", metrics, criteria, [], issues, stale, completeness, score);
}

function build(
  snap: PairSnapshot,
  status: PairRank["status"],
  metrics: PairMetrics,
  criteria: CriterionScore[],
  reasons: string[],
  issues: string[],
  stale: string[],
  completeness = 0,
  score: number | null = null,
): PairRank {
  return {
    symbol: snap.symbol,
    baseCurrency: snap.baseCurrency,
    quoteCurrency: snap.quoteCurrency,
    exchange: snap.exchange,
    marketType: snap.marketType,
    status,
    score: status === "RANKED" ? score : null,
    partial: status === "RANKED" && completeness < 1,
    reasons,
    criteria,
    metrics,
    dataQuality: { completeness, stale, issues },
    updatedAt: snap.statsTs ?? snap.bookTs ?? Date.now(),
  };
}
