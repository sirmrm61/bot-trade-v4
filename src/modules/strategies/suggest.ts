import type { Candle } from "@/modules/exchanges/types";
import { clamp } from "@/shared/utils";

/**
 * Market-aware parameter suggestion.
 * Given recent candles + a risk profile, derives per-engine parameters
 * (and shared risk fields) tuned to the current volatility / trend / volume.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface MarketStats {
  candles: number;
  /** std of per-candle log-returns, % */
  volPct: number;
  /** mean (high-low)/close, % */
  atrPct: number;
  /** net drift over the window, % */
  trendPct: number;
  /** recent 20-candle volume / overall mean volume */
  volRatio: number;
  regime: "ranging" | "trending" | "volatile";
}

export function marketStats(candles: Candle[]): MarketStats {
  const n = candles.length;
  const rets: number[] = [];
  let atrSum = 0;
  for (let i = 1; i < n; i++) {
    const p = candles[i - 1].close;
    if (p > 0 && candles[i].close > 0) rets.push(Math.log(candles[i].close / p));
  }
  for (const c of candles) atrSum += c.close > 0 ? (c.high - c.low) / c.close : 0;
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const varr = rets.length ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length : 0;
  const volPct = Math.sqrt(varr) * 100;
  const atrPct = (atrSum / Math.max(n, 1)) * 100;
  const trendPct = n > 1 && candles[0].close > 0 ? (candles[n - 1].close / candles[0].close - 1) * 100 : 0;
  const vols = candles.map((c) => c.volume);
  const volMean = vols.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const recent = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.max(Math.min(n, 20), 1);
  const volRatio = volMean > 0 ? recent / volMean : 1;

  const regime =
    volPct > 2 ? "volatile" : Math.abs(trendPct) > Math.max(8, volPct * 6) ? "trending" : "ranging";
  return { candles: n, volPct, atrPct, trendPct, volRatio, regime };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
/** snap to a 0.05 grid — matches the step attribute of the percent inputs */
const round05 = (v: number) => Math.round(v / 0.05) * 0.05;

export type FieldValue = number | string | boolean;

/**
 * Returns a map of form-field name → suggested value.
 * Names match the builder inputs exactly so the client can apply them
 * directly onto uncontrolled inputs (value / checked).
 */
export function suggestParams(
  kind: string,
  risk: RiskLevel,
  stats: MarketStats,
): { fields: Record<string, FieldValue>; notes: string[] } {
  const fields: Record<string, FieldValue> = {};
  const notes: string[] = [];
  const { volPct, atrPct, trendPct, regime, candles: n } = stats;

  // ---------- shared risk fields ----------
  const riskPct = risk === "LOW" ? 0.5 : risk === "HIGH" ? 2 : 1;
  const maxPos = risk === "LOW" ? 50 : risk === "HIGH" ? 100 : 75;
  // SL ≈ k × per-candle ATR — a stop must survive a handful of normal candles
  const kSl = risk === "LOW" ? 2 : risk === "HIGH" ? 4 : 3;
  const rr = risk === "LOW" ? 1.6 : risk === "HIGH" ? 2.5 : 2;
  const sl = round1(clamp(atrPct * kSl, 0.4, 12));
  fields.riskPerTradePct = riskPct;
  fields.maxPositionPct = maxPos;
  fields.stopLossPct = sl;
  fields.takeProfitPct = round1(clamp(sl * rr, 0.5, 30));
  fields.trailingStop = regime === "trending";
  fields.trailingStopPct = round1(clamp(atrPct * 2.5, 0.3, 15));
  fields.leverage = risk === "LOW" ? 2 : risk === "HIGH" ? 5 : 3;
  notes.push(
    `حد ضرر/سود از نوسان واقعی بازار (ATR≈${round2(atrPct)}٪ در کندل) اقتباس شد: SL=${fa(sl)}٪، TP=${fa(round1(clamp(sl * rr, 0.5, 30)))}٪`,
  );

  // ---------- per-engine ----------
  if (kind === "ATM_SME") {
    // volatile market → shorter vol window + higher γ to damp Vt saturation
    fields.volWindow = volPct > 1.5 ? 14 : volPct > 0.8 ? 20 : 30;
    fields.gamma = round1(clamp(1.5 * (volPct / 0.8), 0.8, 4));
    fields.tokenMid = risk === "LOW" ? 0.25 : risk === "HIGH" ? 0.15 : 0.2;
    fields.tokenExtreme = risk === "LOW" ? 0.7 : risk === "HIGH" ? 0.5 : 0.6;
    fields.emaPeriod = risk === "LOW" ? 13 : risk === "HIGH" ? 7 : 9;
    fields.useEmaConfirm = risk !== "HIGH";
    fields.recoverVt = risk === "LOW" ? -0.05 : risk === "HIGH" ? -0.3 : -0.15;
    fields.weakenVt = risk === "LOW" ? 0.05 : risk === "HIGH" ? 0.3 : 0.15;
    fields.minPatternWinRate = risk === "LOW" ? 0.7 : risk === "HIGH" ? 0.55 : 0.65;
    fields.minPatternCount = risk === "LOW" ? 4 : risk === "HIGH" ? 2 : 3;
    // pattern stats need room — cap the window to ~60% of available history
    fields.probWindow = Math.max(30, Math.min(300, Math.floor(n * 0.6)));
    fields.exitTrigger = risk === "LOW" ? 0.6 : risk === "HIGH" ? 0.8 : 0.7;
    fields.exitBack = risk === "LOW" ? 0.5 : risk === "HIGH" ? 0.3 : 0.4;
    fields.decayLookback = risk === "LOW" ? 8 : risk === "HIGH" ? 14 : 10;
    notes.push(`γ با نوسان ${round2(volPct)}٪ در کندل تنظیم شد تا Vt در بازار پرنوسان اشباع نشود.`);
  }

  if (kind === "RMM_BSE") {
    fields.channelLen = volPct > 1.5 ? 30 : volPct > 0.8 ? 20 : 14;
    // ranging market → wider squeeze band catches more compressions
    fields.squeezeAbs = round2(clamp((regime === "ranging" ? 0.4 : 0.35) + (risk === "HIGH" ? 0.05 : risk === "LOW" ? -0.05 : 0), 0.1, 0.6));
    fields.squeezeBars = risk === "LOW" ? 8 : risk === "HIGH" ? 3 : 5;
    fields.breakoutMt = risk === "LOW" ? 0.9 : risk === "HIGH" ? 0.75 : 0.85;
    fields.exitMt = risk === "LOW" ? 0.2 : risk === "HIGH" ? 0 : 0.1;
    fields.useVolumeConfirm = risk !== "HIGH";
    fields.volMult = risk === "LOW" ? 2 : risk === "HIGH" ? 1.2 : 1.5;
    fields.volPeriod = 20;
    notes.push(
      regime === "ranging"
        ? "بازار فعلاً رنج است — باند فشردگی بازتر شد تا انباشت انرژی قبل از شکست بهتر دیده شود."
        : "بازار دارای روند است — تایید حجم در ورود توصیه می‌شود تا شکست‌های کاذب فیلتر شوند.",
    );
  }

  if (kind === "DZS_HMM") {
    fields.zWindow = Math.min(Math.floor(n * 0.5), volPct > 1.5 ? 80 : volPct > 0.8 ? 60 : 45);
    fields.dzsFeature = regime === "ranging" ? "deviation" : "return";
    fields.emitCenter = volPct > 1.5 ? 0.7 : volPct < 0.5 ? 0.5 : 0.6;
    fields.emitSigma = volPct > 1.5 ? 0.45 : volPct < 0.5 ? 0.3 : 0.35;
    const pStayBase = regime === "trending" ? 0.95 : regime === "ranging" ? 0.85 : 0.9;
    fields.pStay = round2(clamp(pStayBase + (risk === "LOW" ? 0.03 : risk === "HIGH" ? -0.05 : 0), 0.7, 0.99));
    fields.bullProb = risk === "LOW" ? 0.8 : risk === "HIGH" ? 0.65 : 0.75;
    fields.sCross = risk === "LOW" ? 0.4 : risk === "HIGH" ? 0.25 : 0.33;
    fields.persist = risk === "LOW" ? 2 : 1;
    const exitP = risk === "LOW" ? 0.5 : risk === "HIGH" ? 0.7 : 0.6;
    fields.rangeProbExit = exitP;
    fields.bearProbExit = exitP;
    notes.push(
      regime === "ranging"
        ? "در بازار رنج، «انحراف از میانگین» به‌عنوان مشاهده انتخاب شد — برگشت به میانگین بهتر تشخیص داده می‌شود."
        : `روند ${trendPct >= 0 ? "صعودی" : "نزولی"} فعال است — مشاهده‌ی «بازده لگاریتمی» و رژیم چسبنده‌تر تنظیم شد.`,
    );
  }

  if (kind === "ORDER_BOOK_IMBALANCE") {
    const th = risk === "LOW" ? 0.25 : risk === "HIGH" ? 0.15 : 0.2;
    fields.buyThreshold = th;
    fields.sellThreshold = -th;
    fields.depthLevels = volPct > 1.5 ? 15 : 10;
    fields.emaPeriod = risk === "LOW" ? 5 : risk === "HIGH" ? 1 : 3;
  }

  if (kind === "MARKET_MAKING") {
    // spread must beat fees + noise — base it on per-candle range
    fields.spreadPct = round05(clamp(atrPct * 1.5, 0.15, 4));
    fields.orderSizePct = risk === "LOW" ? 5 : risk === "HIGH" ? 15 : 10;
    fields.levels = risk === "LOW" ? 3 : risk === "HIGH" ? 1 : 2;
    fields.levelStepPct = round05(clamp(atrPct, 0.1, 3));
    fields.requotePct = round05(clamp(atrPct * 0.5, 0.05, 2));
    fields.maxInventoryPct = risk === "LOW" ? 40 : risk === "HIGH" ? 80 : 60;
    notes.push(`اسپرد از میانگین رنج کندل‌ها (≈${round2(atrPct)}٪) مشتق شد تا کارمزد و نویز را پوشش دهد.`);
  }

  const riskFa = { LOW: "محافظه‌کار", MEDIUM: "متعادل", HIGH: "تهاجمی" }[risk];
  notes.unshift(
    `تحلیل ${n} کندل اخیر: نوسان ${round2(volPct)}٪، روند ${round2(trendPct)}٪ — بازار ${
      { ranging: "رنج", trending: "روند", volatile: "پرنوسان" }[regime]
    } · پروفایل ${riskFa}`,
  );

  return { fields, notes };
}

function fa(v: number) {
  return v.toLocaleString("fa-IR", { maximumFractionDigits: 2 });
}
