import type { Candle } from "@/modules/exchanges/types";
import { clamp, parseJson } from "@/shared/utils";
import { atr, ema } from "@/modules/indicators/engine";
import type { PriceActionConfigInput } from "@/modules/strategies/service";
import { PRICE_ACTION_SETUPS, type PriceActionSetup } from "@/shared/constants";

/**
 * Price-Action engines — pure candle/structure setups, no classic
 * indicators except ATR (tolerance sizing) and EMA (pullback anchor).
 *
 * One strategy kind: PRICE_ACTION. `priceAction.setup` selects which of
 * the 16 setups runs. All detectors evaluate CLOSED candles only — a
 * signal at index i uses candles[0..i].
 */

export const PA_SETUPS = PRICE_ACTION_SETUPS;
export type PaSetup = PriceActionSetup;

export interface PaConfig {
  setup: PaSetup;
  lookback: number;       // structure/zone window (default 60)
  swingLen: number;       // fractal width — candles each side (default 3)
  zoneTolPct: number;     // touch tolerance % (default 0.3)
  minWickRatio: number;   // wick/body for pin bar (default 2)
  impulseAtrMult: number; // impulse = mult × ATR (default 1.5)
  emaPeriod: number;      // EMA anchor for pullbacks (default 50)
  bodyRatio: number;      // min body/range for momentum & engulfing (default 0.6)
  volMult: number;        // volume confirm for momentum (default 1.5; 0 = off)
  rangeMaxPct: number;    // ceiling of range for mean-reversion (default 6%)
}

export function readPaConfig(configJson: string): PaConfig {
  const c = parseJson<{ priceAction?: Partial<PriceActionConfigInput> }>(configJson, {}).priceAction ?? {};
  const setup = (PA_SETUPS as readonly string[]).includes(c.setup ?? "")
    ? (c.setup as PaSetup) : "PIN_BAR";
  return {
    setup,
    lookback: clamp(Math.floor(c.lookback ?? 60), 10, 500),
    swingLen: clamp(Math.floor(c.swingLen ?? 3), 1, 20),
    zoneTolPct: clamp(c.zoneTolPct ?? 0.3, 0.05, 5),
    minWickRatio: clamp(c.minWickRatio ?? 2, 1, 10),
    impulseAtrMult: clamp(c.impulseAtrMult ?? 1.5, 0.5, 10),
    emaPeriod: clamp(Math.floor(c.emaPeriod ?? 50), 5, 300),
    bodyRatio: clamp(c.bodyRatio ?? 0.6, 0.3, 0.95),
    volMult: clamp(c.volMult ?? 1.5, 0, 20),
    rangeMaxPct: clamp(c.rangeMaxPct ?? 6, 1, 30),
  };
}

export function isPriceActionKind(kind: string): boolean {
  return kind === "PRICE_ACTION";
}

/** minimum candles before signals can be evaluated */
export function paWarmup(configJson: string): number {
  const c = readPaConfig(configJson);
  return Math.max(c.lookback + 2 * c.swingLen + 5, c.emaPeriod + 20, 80);
}

// ============================================================================
// helpers
// ============================================================================

type Signal = "BUY" | "SELL" | "HOLD";
export interface PaSignal {
  signal: Signal;
  /** confidence 0..1 — the UI label carries the plain explanation */
  score: number;
  label: string;
  detail?: Record<string, unknown>;
}

const HOLD: PaSignal = { signal: "HOLD", score: 0, label: "هولد" };
const sig = (signal: Signal, score: number, label: string, detail?: Record<string, unknown>): PaSignal =>
  ({ signal, score: clamp(score, 0, 1), label, detail });

const body = (c: Candle) => c.close - c.open;
const absBody = (c: Candle) => Math.abs(c.close - c.open);
const rng = (c: Candle) => c.high - c.low;
const uw = (c: Candle) => c.high - Math.max(c.open, c.close);
const lw = (c: Candle) => Math.min(c.open, c.close) - c.low;
const bull = (c: Candle) => c.close > c.open;
const EPS = 1e-10;

export interface Swing { i: number; price: number }

/** fractal swings — index i is a swing if its extreme beats `k` neighbours each side */
export function swingPoints(cs: Candle[], k: number): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (cs[i].high <= cs[i - j].high || cs[i].high <= cs[i + j].high) hi = false;
      if (cs[i].low >= cs[i - j].low || cs[i].low >= cs[i + j].low) lo = false;
    }
    if (hi) highs.push({ i, price: cs[i].high });
    if (lo) lows.push({ i, price: cs[i].low });
  }
  return { highs, lows };
}

const tol = (cfg: PaConfig, price: number) => (cfg.zoneTolPct / 100) * price;

interface Ctx { atr: number[]; ema: number[] }

// ============================================================================
// detectors — (cs, i, cfg, ctx) → PaSignal at index i
// ============================================================================

function dPinBar(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const c = cs[i];
  const r = rng(c), b = Math.max(absBody(c), EPS);
  const tail = lw(c), nose = uw(c);
  if (tail >= cfg.minWickRatio * b && tail >= 0.55 * r && nose <= 0.35 * r) {
    return sig("BUY", 0.5 + 0.5 * Math.min(tail / r, 1), "پین‌بار صعودی — رد قیمت از پایین", { wickPct: tail / r });
  }
  if (nose >= cfg.minWickRatio * b && nose >= 0.55 * r && tail <= 0.35 * r) {
    return sig("SELL", 0.5 + 0.5 * Math.min(nose / r, 1), "پین‌بار نزولی — رد قیمت از بالا", { wickPct: nose / r });
  }
  return HOLD;
}

function dEngulfing(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const p = cs[i - 1], c = cs[i];
  if (absBody(c) < cfg.bodyRatio * rng(c)) return HOLD;
  if (!bull(p) && bull(c) && c.close > p.open && c.open < p.close && absBody(c) >= absBody(p)) {
    return sig("BUY", Math.min(absBody(c) / (absBody(p) + EPS), 2) / 2, "بلع صعودی", { engulfRatio: absBody(c) / (absBody(p) + EPS) });
  }
  if (bull(p) && !bull(c) && c.close < p.open && c.open > p.close && absBody(c) >= absBody(p)) {
    return sig("SELL", Math.min(absBody(c) / (absBody(p) + EPS), 2) / 2, "بلع نزولی", { engulfRatio: absBody(c) / (absBody(p) + EPS) });
  }
  return HOLD;
}

function dInsideBar(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  const mother = cs[i - 2], inside = cs[i - 1], c = cs[i];
  if (!(inside.high < mother.high && inside.low > mother.low)) return HOLD;
  if (c.close > mother.high) return sig("BUY", Math.min(rng(mother) / (ctx.atr[i] || EPS), 3) / 3, "شکست کندل داخلی به بالا");
  if (c.close < mother.low) return sig("SELL", Math.min(rng(mother) / (ctx.atr[i] || EPS), 3) / 3, "شکست کندل داخلی به پایین");
  return HOLD;
}

function dStar(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  const a = cs[i - 2], b = cs[i - 1], c = cs[i];
  const bigA = absBody(a) >= cfg.bodyRatio * rng(a) && rng(a) >= 0.7 * (ctx.atr[i] || EPS);
  const smallB = absBody(b) <= 0.3 * rng(b) || absBody(b) <= 0.3 * absBody(a);
  const midA = (a.open + a.close) / 2;
  if (bigA && !bull(a) && smallB && bull(c) && c.close > midA) {
    return sig("BUY", Math.min((c.close - midA) / (absBody(a) / 2 + EPS), 1), "ستاره‌ی صبح — برگشت صعودی");
  }
  if (bigA && bull(a) && smallB && !bull(c) && c.close < midA) {
    return sig("SELL", Math.min((midA - c.close) / (absBody(a) / 2 + EPS), 1), "ستاره‌ی عصر — برگشت نزولی");
  }
  return HOLD;
}

function dBos(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const { highs, lows } = swingPoints(cs.slice(0, i + 1), cfg.swingLen);
  const sh = highs.filter((s) => s.i <= i - cfg.swingLen - 1).at(-1);
  const sl = lows.filter((s) => s.i <= i - cfg.swingLen - 1).at(-1);
  if (sh && cs[i].close > sh.price) {
    return sig("BUY", Math.min((cs[i].close - sh.price) / (sh.price * 0.01 + EPS), 1), "شکست ساختار صعودی (BOS)", { level: sh.price });
  }
  if (sl && cs[i].close < sl.price) {
    return sig("SELL", Math.min((sl.price - cs[i].close) / (sl.price * 0.01 + EPS), 1), "شکست ساختار نزولی (BOS)", { level: sl.price });
  }
  return HOLD;
}

function dChoch(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const sw = swingPoints(cs.slice(0, i + 1), cfg.swingLen);
  const H = sw.highs.filter((s) => s.i <= i - cfg.swingLen - 1);
  const L = sw.lows.filter((s) => s.i <= i - cfg.swingLen - 1);
  if (H.length < 2 || L.length < 2) return HOLD;
  const [h1, h2] = H.slice(-2), [l1, l2] = L.slice(-2);
  const downtrend = h2.price < h1.price && l2.price < l1.price;
  const uptrend = h2.price > h1.price && l2.price > l1.price;
  if (downtrend && cs[i].close > h2.price) {
    return sig("BUY", 0.7, "تغییر ساختار به صعودی (CHoCH)", { level: h2.price });
  }
  if (uptrend && cs[i].close < l2.price) {
    return sig("SELL", 0.7, "تغییر ساختار به نزولی (CHoCH)", { level: l2.price });
  }
  return HOLD;
}

function dTrendPullback(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  const e = ctx.ema[i], ePrev = ctx.ema[Math.max(0, i - Math.floor(cfg.lookback / 3))];
  if (!Number.isFinite(e) || !Number.isFinite(ePrev)) return HOLD;
  const t = tol(cfg, cs[i].close);
  if (e > ePrev && cs[i].low <= e + t && cs[i].close > e && bull(cs[i])) {
    return sig("BUY", 0.6, "پولبک صعودی به میانگین در روند", { ema: e });
  }
  if (e < ePrev && cs[i].high >= e - t && cs[i].close < e && !bull(cs[i])) {
    return sig("SELL", 0.6, "پولبک نزولی به میانگین در روند", { ema: e });
  }
  return HOLD;
}

function dTrendlineBounce(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const sw = swingPoints(cs.slice(0, i + 1), cfg.swingLen);
  const t = tol(cfg, cs[i].close);
  const L = sw.lows.filter((s) => s.i <= i - cfg.swingLen - 1);
  if (L.length >= 2) {
    const [a, b] = L.slice(-2);
    if (b.price > a.price) { // rising trendline
      const slope = (b.price - a.price) / (b.i - a.i);
      const lineNow = b.price + slope * (i - b.i);
      if (cs[i].low <= lineNow + t && cs[i].close > lineNow && bull(cs[i])) {
        return sig("BUY", 0.65, "برگشت از خط روند صعودی", { line: lineNow });
      }
    }
  }
  const H = sw.highs.filter((s) => s.i <= i - cfg.swingLen - 1);
  if (H.length >= 2) {
    const [a, b] = H.slice(-2);
    if (b.price < a.price) { // falling trendline
      const slope = (b.price - a.price) / (b.i - a.i);
      const lineNow = b.price + slope * (i - b.i);
      if (cs[i].high >= lineNow - t && cs[i].close < lineNow && !bull(cs[i])) {
        return sig("SELL", 0.65, "برگشت از خط روند نزولی", { line: lineNow });
      }
    }
  }
  return HOLD;
}

function dOrderBlock(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  const t = tol(cfg, cs[i].close);
  for (let j = i - 2; j >= Math.max(2, i - cfg.lookback); j--) {
    const a = ctx.atr[j] || 0;
    if (bull(cs[j]) && body(cs[j]) >= cfg.impulseAtrMult * a) {
      // last bearish candle before the impulse = bullish order block
      const ob = cs[j - 1];
      if (bull(ob)) continue;
      const [lo, hi] = [ob.low, ob.high];
      // zone must be un-consumed: no close below it since the impulse
      if (cs.slice(j + 1, i).some((k) => k.close < lo)) continue;
      if (cs[i].low <= hi + t && cs[i].close > lo && bull(cs[i])) {
        return sig("BUY", 0.65, "ورود از اوردر بلاک صعودی", { zoneLo: lo, zoneHi: hi });
      }
      continue;
    }
    if (!bull(cs[j]) && -body(cs[j]) >= cfg.impulseAtrMult * a) {
      const ob = cs[j - 1];
      if (!bull(ob)) continue;
      const [lo, hi] = [ob.low, ob.high];
      if (cs.slice(j + 1, i).some((k) => k.close > hi)) continue;
      if (cs[i].high >= lo - t && cs[i].close < hi && !bull(cs[i])) {
        return sig("SELL", 0.65, "ورود از اوردر بلاک نزولی", { zoneLo: lo, zoneHi: hi });
      }
      continue;
    }
  }
  return HOLD;
}

function dFvg(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const t = tol(cfg, cs[i].close);
  for (let j = i - 2; j >= Math.max(0, i - cfg.lookback); j--) {
    if (j + 2 >= cs.length) continue;
    // bullish FVG — gap between candle j's high and j+2's low
    if (cs[j + 2].low > cs[j].high) {
      const [lo, hi] = [cs[j].high, cs[j + 2].low];
      if (cs.slice(j + 3, i).some((k) => k.low < lo)) continue; // already filled
      if (cs[i].low <= hi + t && cs[i].close > lo && bull(cs[i])) {
        return sig("BUY", 0.6, "ورود به گپ صعودی (FVG)", { gapLo: lo, gapHi: hi });
      }
      break;
    }
    // bearish FVG — gap between j+2's high and j's low
    if (cs[j + 2].high < cs[j].low) {
      const [lo, hi] = [cs[j + 2].high, cs[j].low];
      if (cs.slice(j + 3, i).some((k) => k.high > hi)) continue;
      if (cs[i].high >= lo - t && cs[i].close < hi && !bull(cs[i])) {
        return sig("SELL", 0.6, "ورود به گپ نزولی (FVG)", { gapLo: lo, gapHi: hi });
      }
      break;
    }
  }
  return HOLD;
}

function dLiquiditySweep(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const { highs, lows } = swingPoints(cs.slice(0, i + 1), cfg.swingLen);
  const sh = highs.filter((s) => s.i <= i - cfg.swingLen - 1).at(-1);
  const sl = lows.filter((s) => s.i <= i - cfg.swingLen - 1).at(-1);
  const c = cs[i];
  if (sh && c.high > sh.price && c.close < sh.price) {
    return sig("SELL", Math.min(uw(c) / (rng(c) + EPS), 1), "شکار نقدینگی بالا — برگشت نزولی", { level: sh.price });
  }
  if (sl && c.low < sl.price && c.close > sl.price) {
    return sig("BUY", Math.min(lw(c) / (rng(c) + EPS), 1), "شکار نقدینگی پایین — برگشت صعودی", { level: sl.price });
  }
  return HOLD;
}

function dSrBounce(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const { highs, lows } = swingPoints(cs.slice(0, i + 1), cfg.swingLen);
  const t = tol(cfg, cs[i].close);
  const sup = lows.filter((s) => s.i <= i - cfg.swingLen - 1).at(-1);
  const res = highs.filter((s) => s.i <= i - cfg.swingLen - 1).at(-1);
  if (sup && cs[i].low <= sup.price + t && cs[i].close > sup.price && bull(cs[i])) {
    return sig("BUY", 0.55, "برگشت از حمایت", { level: sup.price });
  }
  if (res && cs[i].high >= res.price - t && cs[i].close < res.price && !bull(cs[i])) {
    return sig("SELL", 0.55, "برگشت از مقاومت", { level: res.price });
  }
  return HOLD;
}

function dBreakoutRetest(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const t = tol(cfg, cs[i].close);
  // find the most recent close that broke the prior window-high/low
  for (let j = i - 1; j > Math.max(0, i - cfg.lookback); j--) {
    const prior = cs.slice(Math.max(0, j - cfg.lookback), j);
    const priorHigh = Math.max(...prior.map((k) => k.high));
    const priorLow = Math.min(...prior.map((k) => k.low));
    if (cs[j].close > priorHigh) {
      // pullback into the broken level — no close back below since the break
      if (cs.slice(j + 1, i).some((k) => k.close < priorHigh)) continue;
      if (cs[i].low <= priorHigh + t && cs[i].close > priorHigh && bull(cs[i])) {
        return sig("BUY", 0.65, "تست مجدد شکست صعودی", { level: priorHigh });
      }
      break;
    }
    if (cs[j].close < priorLow) {
      if (cs.slice(j + 1, i).some((k) => k.close > priorLow)) continue;
      if (cs[i].high >= priorLow - t && cs[i].close < priorLow && !bull(cs[i])) {
        return sig("SELL", 0.65, "تست مجدد شکست نزولی", { level: priorLow });
      }
      break;
    }
  }
  return HOLD;
}

function dRangeReversion(cs: Candle[], i: number, cfg: PaConfig): PaSignal {
  const win = cs.slice(Math.max(0, i - cfg.lookback), i + 1);
  const hi = Math.max(...win.map((k) => k.high));
  const lo = Math.min(...win.map((k) => k.low));
  const rangePct = ((hi - lo) / (lo + EPS)) * 100;
  if (rangePct > cfg.rangeMaxPct) return HOLD;
  const pos = (cs[i].close - lo) / (hi - lo + EPS);
  if (pos <= 0.2 && bull(cs[i])) return sig("BUY", 1 - pos, "برگشت از کف رنج", { pos });
  if (pos >= 0.8 && !bull(cs[i])) return sig("SELL", pos, "برگشت از سقف رنج", { pos });
  return HOLD;
}

function dMomentumCandle(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  const c = cs[i], a = ctx.atr[i] || 0;
  const strong = rng(c) >= cfg.impulseAtrMult * a && absBody(c) >= cfg.bodyRatio * rng(c);
  if (!strong) return HOLD;
  if (cfg.volMult > 0) {
    const vWin = cs.slice(Math.max(0, i - 20), i).map((k) => k.volume);
    const avgV = vWin.reduce((s, v) => s + v, 0) / Math.max(vWin.length, 1);
    if (avgV > 0 && c.volume < cfg.volMult * avgV) return HOLD;
  }
  return bull(c)
    ? sig("BUY", Math.min(rng(c) / (3 * a + EPS), 1), "کندل مومنتوم صعودی")
    : sig("SELL", Math.min(rng(c) / (3 * a + EPS), 1), "کندل مومنتوم نزولی");
}

function dEmaPullback(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  const e = ctx.ema[i], eSlope = ctx.ema[i] - ctx.ema[Math.max(0, i - 10)];
  if (!Number.isFinite(e) || !Number.isFinite(eSlope)) return HOLD;
  const t = tol(cfg, cs[i].close);
  if (eSlope > 0 && cs[i].low <= e + t && cs[i].close > e && bull(cs[i])) {
    return sig("BUY", 0.6, `پولبک به EMA(${cfg.emaPeriod}) در روند صعودی`, { ema: e });
  }
  if (eSlope < 0 && cs[i].high >= e - t && cs[i].close < e && !bull(cs[i])) {
    return sig("SELL", 0.6, `پولبک به EMA(${cfg.emaPeriod}) در روند نزولی`, { ema: e });
  }
  return HOLD;
}

const DETECTORS: Record<PaSetup, (cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx) => PaSignal> = {
  PIN_BAR: dPinBar,
  ENGULFING: dEngulfing,
  INSIDE_BAR: dInsideBar,
  STAR: dStar,
  BOS: dBos,
  CHOCH: dChoch,
  TREND_PULLBACK: dTrendPullback,
  TRENDLINE_BOUNCE: dTrendlineBounce,
  ORDER_BLOCK: dOrderBlock,
  FVG: dFvg,
  LIQUIDITY_SWEEP: dLiquiditySweep,
  SR_BOUNCE: dSrBounce,
  BREAKOUT_RETEST: dBreakoutRetest,
  RANGE_REVERSION: dRangeReversion,
  MOMENTUM_CANDLE: dMomentumCandle,
  EMA_PULLBACK: dEmaPullback,
};

// ============================================================================
// public API — mirrors symbolicLast/symbolicSignalFn so live + backtest share it
// ============================================================================

function evalAt(cs: Candle[], i: number, cfg: PaConfig, ctx: Ctx): PaSignal {
  if (i < 3 || i >= cs.length) return HOLD;
  return DETECTORS[cfg.setup](cs, i, cfg, ctx);
}

/** signal on the last closed candle — used by liveTick */
export function paSignal(configJson: string, candles: Candle[]): PaSignal {
  const cfg = readPaConfig(configJson);
  const ctx: Ctx = { atr: atr(candles, 14), ema: ema(candles.map((c) => c.close), cfg.emaPeriod) };
  return evalAt(candles, candles.length - 1, cfg, ctx);
}

/** per-index signal fn for runBacktest */
export function paSignalFn(configJson: string, candles: Candle[]): (i: number) => "BUY" | "SELL" | "HOLD" {
  const cfg = readPaConfig(configJson);
  const ctx: Ctx = { atr: atr(candles, 14), ema: ema(candles.map((c) => c.close), cfg.emaPeriod) };
  return (i) => evalAt(candles, i, cfg, ctx).signal;
}
