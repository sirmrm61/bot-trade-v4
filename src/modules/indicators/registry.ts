/**
 * Indicator Registry — single source of truth for the strategy builder UI
 * and the signal/backtest engines. To add an indicator:
 *   1. implement the math in engine.ts (pure function, NaN-padded to candle length)
 *   2. add a case in computeIndicator() + defaultScore() (or NON_SCORING if risk-only)
 *   3. register it here — the UI renders it automatically.
 * Pure data — safe to import from client components.
 */

export type IndicatorRole = "signal" | "risk";

export interface IndicatorDef {
  /** persisted StrategyIndicator.name */
  key: string;
  /** Persian display label */
  label: string;
  role: IndicatorRole;
  /** signal indicators participate in weighted score; risk ones configure SL/TP */
  scoring: boolean;
  /** where it renders on the chart: price overlay | separate pane | hidden */
  pane: "price" | "oscillator" | "none";
  defaultParams: Record<string, number>;
  /** suggested weight (fraction, sums to 1 for enabled defaults) */
  defaultWeight: number;
  /** default enabled in the builder for new strategies */
  defaultEnabled: boolean;
  defaultBuyCondition?: { op: string; value?: number; target?: string };
  defaultSellCondition?: { op: string; value?: number; target?: string };
  /** short Persian description shown in UI */
  description: string;
}

export const INDICATORS: IndicatorDef[] = [
  {
    key: "RSI", label: "RSI (شاخص قدرت نسبی)", role: "signal", scoring: true, pane: "oscillator",
    defaultParams: { period: 7 }, defaultWeight: 0.3, defaultEnabled: true,
    defaultBuyCondition: { op: "lt", value: 30 }, defaultSellCondition: { op: "gt", value: 70 },
    description: "اشباع خرید/فروش — اسکلپ با دوره کوتاه",
  },
  {
    key: "EMA", label: "EMA (میانگین نمایی)", role: "signal", scoring: true, pane: "price",
    defaultParams: { period: 9 }, defaultWeight: 0.25, defaultEnabled: true,
    defaultBuyCondition: { op: "cross_above", target: "price" },
    defaultSellCondition: { op: "cross_below", target: "price" },
    description: "روند قیمت — عبور قیمت از EMA",
  },
  {
    key: "SMA", label: "SMA (میانگین ساده)", role: "signal", scoring: true, pane: "price",
    defaultParams: { period: 50 }, defaultWeight: 0.1, defaultEnabled: false,
    defaultBuyCondition: { op: "cross_above", target: "price" },
    defaultSellCondition: { op: "cross_below", target: "price" },
    description: "میانگین ساده بلندمدت‌تر",
  },
  {
    key: "MACD", label: "MACD", role: "signal", scoring: true, pane: "oscillator",
    defaultParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    defaultWeight: 0.25, defaultEnabled: true,
    defaultBuyCondition: { op: "gt", value: 0 }, defaultSellCondition: { op: "lt", value: 0 },
    description: "هیستوگرام مومنتوم — برای اسکلپ ۵/۱۳/۱ هم می‌توانید بگذارید",
  },
  {
    key: "BOLLINGER", label: "باند بولینگر", role: "signal", scoring: true, pane: "price",
    defaultParams: { period: 20, stdDev: 2 }, defaultWeight: 0.2, defaultEnabled: true,
    defaultBuyCondition: { op: "lt", value: 0.1 }, defaultSellCondition: { op: "gt", value: 0.9 },
    description: "نوسان نسبت به باندهای انحراف معیار",
  },
  {
    key: "VWAP", label: "VWAP (میانگین وزنی حجم)", role: "signal", scoring: true, pane: "price",
    defaultParams: {}, defaultWeight: 0.15, defaultEnabled: false,
    defaultBuyCondition: { op: "cross_above", target: "price" },
    defaultSellCondition: { op: "cross_below", target: "price" },
    description: "قیمت بالای VWAP روزانه = قدرت خریداران",
  },
  {
    key: "STOCHASTIC", label: "استوکستیک", role: "signal", scoring: true, pane: "oscillator",
    defaultParams: { kPeriod: 5, dPeriod: 3, smoothing: 3 }, defaultWeight: 0.15, defaultEnabled: false,
    defaultBuyCondition: { op: "cross_above", target: "secondary" },
    defaultSellCondition: { op: "cross_below", target: "secondary" },
    description: "اشباع خرید/فروش سریع — مناسب اسکلپ (۵/۳/۳)",
  },
  {
    key: "OBV", label: "OBV (حجم متوازن)", role: "signal", scoring: true, pane: "oscillator",
    defaultParams: { period: 20 }, defaultWeight: 0.1, defaultEnabled: false,
    defaultBuyCondition: { op: "cross_above", target: "secondary" },
    defaultSellCondition: { op: "cross_below", target: "secondary" },
    description: "تأیید روند قیمت با جریان حجم",
  },
  {
    key: "ATR", label: "ATR (محدوده واقعی)", role: "risk", scoring: false, pane: "none",
    defaultParams: { period: 14, slMultiplier: 1.5, tpMultiplier: 2.5 },
    defaultWeight: 0, defaultEnabled: false,
    description: "فقط برای حد ضرر/سود پویا — در امتیاز سیگنال دخالت ندارد",
  },
];

export const INDICATOR_MAP = new Map(INDICATORS.map((d) => [d.key, d]));

export function indicatorDef(key: string): IndicatorDef | undefined {
  return INDICATOR_MAP.get(key.toUpperCase());
}
