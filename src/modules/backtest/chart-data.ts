import { getCandles } from "@/modules/pairs/service";
import { sma, ema, rsi, macd, bollinger, vwap, atr, stochastic, obv, computeIndicator, evaluateCondition, defaultScore, NON_SCORING, type Condition } from "@/modules/indicators/engine";
import { obiProxySeries } from "@/modules/trading/orderbook-imbalance";
import { isSymbolicKind, symbolicChartSeries, symbolicSignalFn } from "@/modules/trading/symbolic-engines";
import { parseJson } from "@/shared/utils";
import type { ChartCandle, OverlaySeries, OscillatorSeries, SignalMark } from "@/components/candle-chart";

export interface ChartResult {
  candles: ChartCandle[];
  overlays: OverlaySeries[];
  oscillators: OscillatorSeries[];
  signals: SignalMark[];
}

const OVERLAY_COLORS = ["#f59e0b", "#3b82f6", "#ec4899", "#14b8a6", "#eab308"];

/**
 * Load candles for a backtest range and compute the strategy version's
 * enabled indicators as chart series. Indicators are computed on the FULL
 * candle set, then downsampled together with the candles so alignment holds.
 */
export async function loadBacktestChart(
  bt: { symbol: string; timeframe: string; startDate: Date; endDate: Date },
  indicators: { name: string; parameters: string; enabled: boolean }[],
  opts: {
    maxCandles?: number;
    buyThreshold?: number;
    sellThreshold?: number;
    indicatorConfigs?: { name: string; parameters: string; weight: number; enabled: boolean; buyCondition: string; sellCondition: string }[];
    /** strategy kind + version config — enables the OBI proxy pane/signals */
    kind?: string;
    config?: string;
  } = {},
): Promise<ChartResult> {
  const { maxCandles = 400, buyThreshold, sellThreshold, indicatorConfigs, kind, config } = opts;
  const empty: ChartResult = { candles: [], overlays: [], oscillators: [], signals: [] };
  let candles;
  try {
    candles = await getCandles({ symbol: bt.symbol, timeframe: bt.timeframe, start: bt.startDate, end: bt.endDate });
  } catch {
    return empty;
  }
  if (candles.length === 0) return empty;

  const closes = candles.map((c) => c.close);
  const fullOverlays: OverlaySeries[] = [];
  const fullOsc: OscillatorSeries[] = [];
  let colorIdx = 0;

  for (const ind of indicators.filter((i) => i.enabled)) {
    const p = parseJson<Record<string, number>>(ind.parameters, {});
    const name = ind.name.toUpperCase();
    try {
      if (name === "SMA") {
        const period = p.period ?? 20;
        fullOverlays.push({ name: `SMA(${period})`, color: OVERLAY_COLORS[colorIdx++ % OVERLAY_COLORS.length], values: sma(closes, period) });
      } else if (name === "EMA") {
        const period = p.period ?? 20;
        fullOverlays.push({ name: `EMA(${period})`, color: OVERLAY_COLORS[colorIdx++ % OVERLAY_COLORS.length], values: ema(closes, period) });
      } else if (name === "BOLLINGER") {
        const b = bollinger(closes, p.period ?? 20, p.stdDev ?? 2);
        const c = "#94a3b8";
        fullOverlays.push(
          { name: `BB بالا`, color: c, values: b.upper },
          { name: `BB میانی`, color: "#64748b", values: b.middle },
          { name: `BB پایین`, color: c, values: b.lower },
        );
      } else if (name === "RSI") {
        const period = p.period ?? 14;
        fullOsc.push({ name: `RSI(${period})`, kind: "rsi", values: rsi(closes, period) });
      } else if (name === "MACD") {
        const m = macd(closes, p.fastPeriod ?? 12, p.slowPeriod ?? 26, p.signalPeriod ?? 9);
        fullOsc.push({ name: "MACD", kind: "macd", values: m.histogram, line: m.macd, signal: m.signal });
      } else if (name === "VWAP") {
        fullOverlays.push({ name: "VWAP", color: "#f97316", values: vwap(candles) });
      } else if (name === "STOCHASTIC") {
        const s = stochastic(candles, p.kPeriod ?? 5, p.dPeriod ?? 3, p.smoothing ?? 3);
        fullOsc.push({ name: "Stochastic", kind: "rsi", values: s.k, line: s.d });
      } else if (name === "OBV") {
        const o = obv(candles);
        fullOsc.push({ name: "OBV", kind: "line", values: o });
      } else if (name === "ATR") {
        fullOsc.push({ name: `ATR(${p.period ?? 14})`, kind: "line", values: atr(candles, p.period ?? 14) });
      }
    } catch {
      /* unknown/bad indicator — skip */
    }
  }

  // per-candle signal evaluation — where the strategy would fire BUY/SELL
  const fullSignals: (SignalMark | null)[] = new Array(candles.length).fill(null);
  if (indicatorConfigs && buyThreshold !== undefined && sellThreshold !== undefined) {
    const active = indicatorConfigs.filter((i) => i.enabled && i.weight > 0 && !NON_SCORING.has(i.name.toUpperCase()));
    const seriesList = active.map((ind) => {
      try {
        return {
          ind,
          series: computeIndicator(ind.name, parseJson<Record<string, number>>(ind.parameters, {}), candles),
          buyCond: parseJson<Condition | null>(ind.buyCondition, null),
          sellCond: parseJson<Condition | null>(ind.sellCondition, null),
        };
      } catch {
        return null;
      }
    }).filter((s): s is NonNullable<typeof s> => s !== null);
    const totalWeight = seriesList.reduce((a, s) => a + s.ind.weight, 0);

    if (totalWeight > 0) {
      for (let i = 0; i < candles.length; i++) {
        let weighted = 0;
        for (const { ind, series, buyCond, sellCond } of seriesList) {
          let score: number;
          if (buyCond && evaluateCondition(buyCond, series, closes, i)) score = 1;
          else if (sellCond && evaluateCondition(sellCond, series, closes, i)) score = -1;
          else score = defaultScore(ind.name, series, closes, i);
          weighted += score * ind.weight;
        }
        const score = weighted / totalWeight;
        if (score >= buyThreshold) {
          fullSignals[i] = { time: candles[i].time, price: candles[i].close, type: "BUY" };
        } else if (score <= sellThreshold) {
          fullSignals[i] = { time: candles[i].time, price: candles[i].close, type: "SELL" };
        }
      }
    }
  }

  // OBI backtest — proxy imbalance pane + signals where the proxy crosses thresholds
  if (kind === "ORDER_BOOK_IMBALANCE" && config !== undefined && buyThreshold !== undefined && sellThreshold !== undefined) {
    const series = obiProxySeries(candles, config);
    fullOsc.push({
      name: "OBI (پروکسی)",
      kind: "line",
      values: series,
      bands: [
        { v: buyThreshold, color: "#16a34a", label: "آستانه خرید" },
        { v: sellThreshold, color: "#dc2626", label: "آستانه فروش" },
      ],
    });
    for (let i = 1; i < candles.length; i++) {
      const cur = series[i];
      const prev = series[i - 1];
      if (!Number.isFinite(cur) || !Number.isFinite(prev)) continue;
      if (prev < buyThreshold && cur >= buyThreshold) {
        fullSignals[i] = { time: candles[i].time, price: candles[i].close, type: "BUY" };
      } else if (prev > sellThreshold && cur <= sellThreshold) {
        fullSignals[i] = { time: candles[i].time, price: candles[i].close, type: "SELL" };
      }
    }
  }

  // symbolic engines — engine value pane (V/M/P-bull) + per-candle BUY/SELL marks
  if (kind !== undefined && config !== undefined && isSymbolicKind(kind)) {
    const pane = symbolicChartSeries(kind, candles, config);
    fullOsc.push({ name: pane.name, kind: "line", values: pane.values, line: pane.line, bands: pane.bands });
    const fn = symbolicSignalFn(kind, candles, config);
    for (let i = 0; i < candles.length; i++) {
      const sig = fn(i);
      if (sig === "BUY") {
        fullSignals[i] = { time: candles[i].time, price: candles[i].close, type: "BUY" };
      } else if (sig === "SELL") {
        fullSignals[i] = { time: candles[i].time, price: candles[i].close, type: "SELL" };
      }
    }
  }

  // downsample everything with the same stride
  const step = Math.max(1, Math.ceil(candles.length / maxCandles));
  const pick = <T>(arr: T[]) => arr.filter((_, i) => i % step === 0);

  return {
    candles: pick(candles),
    overlays: fullOverlays.map((o) => ({ ...o, values: pick(o.values) })),
    oscillators: fullOsc.map((o) => ({
      ...o,
      values: pick(o.values),
      line: o.line ? pick(o.line) : undefined,
      signal: o.signal ? pick(o.signal) : undefined,
    })),
    // signals are sparse — keep all of them regardless of stride
    signals: fullSignals.filter((s): s is SignalMark => s !== null),
  };
}
