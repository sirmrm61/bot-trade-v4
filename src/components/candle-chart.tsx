"use client";

import { useRef, useState, useCallback, useEffect } from "react";

/**
 * Interactive candlestick chart (pure SVG).
 * - Wheel: zoom around cursor · Drag: pan · Double-click: reset
 * - Price pane: OHLC candles + indicator overlays + signal diamonds + trade markers
 * - Optional oscillator pane below (RSI / MACD)
 */
export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradeMark {
  entryTime: number;
  exitTime?: number | null;
  entryPrice: number;
  exitPrice?: number | null;
  pnl?: number | null;
  /** SIGNAL | STOP_LOSS | TAKE_PROFIT | TRAILING_STOP | END */
  exitReason?: string | null;
}

/** Where the strategy WOULD fire a signal (even if no trade was taken) */
export interface SignalMark {
  time: number;
  price: number;
  type: "BUY" | "SELL";
}

export interface OverlaySeries {
  name: string;
  color: string;
  values: number[]; // same length as candles (NaN where undefined)
}

export interface OscillatorSeries {
  name: string;
  /** rsi = 0..100 pane (bands 30/70) · macd = histogram+lines · line = auto-range single line */
  kind: "rsi" | "macd" | "line";
  values: number[];
  /** secondary line (e.g. stochastic %D) */
  line?: number[];
  signal?: number[];
  /** dashed trigger thresholds (e.g. OBI buy/sell score) drawn on a "line" pane */
  bands?: { v: number; color: string; label: string }[];
}

/** Horizontal trigger level — a price where an order/exit fires on touch. */
export interface PriceLevel {
  price: number;
  color: string;
  label: string;
}

const W = 960;
const PAD_L = 8;
const PAD_R = 76;
const PAD_T = 14;
const PAD_B = 26;
const PRICE_H = 300;
const OSC_H = 110;
const GAP = 16;
const MIN_SPAN = 10; // min candles visible

const EXIT_STYLE: Record<string, { color: string; label: string }> = {
  TAKE_PROFIT: { color: "#0d9488", label: "حد سود" },
  STOP_LOSS: { color: "#dc2626", label: "حد ضرر" },
  TRAILING_STOP: { color: "#f59e0b", label: "تریلینگ" },
  END: { color: "#64748b", label: "پایان تست" },
  SIGNAL: { color: "#2563eb", label: "فروش سیگنال" },
};

function fmtPrice(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(2);
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleDateString("fa-IR", { month: "short", day: "numeric" });
}

function nearestIndex(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return Math.min(lo, times.length - 1);
}

/** polyline points, skipping NaN gaps — only for visible index range */
function linePoints(values: number[], x: (i: number) => number, y: (v: number) => number, lo: number, hi: number): string {
  const segs: string[] = [];
  let open = false;
  for (let i = lo; i <= hi && i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { open = false; continue; }
    segs.push(`${open ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    open = true;
  }
  return segs.join(" ");
}

function exitColor(t: TradeMark): string {
  return EXIT_STYLE[t.exitReason ?? "SIGNAL"]?.color ?? "#2563eb";
}

export function CandleChart({
  candles,
  trades,
  overlays = [],
  oscillators = [],
  signals = [],
  levels = [],
}: {
  candles: ChartCandle[];
  trades: TradeMark[];
  overlays?: OverlaySeries[];
  oscillators?: OscillatorSeries[];
  signals?: SignalMark[];
  levels?: PriceLevel[];
}) {
  const n = candles.length;
  // visible window as index range [start, end] (float; fractional ok)
  const [view, setView] = useState<[number, number]>([0, n - 1]);
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; v0: number; v1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // live updates: if the user hasn't zoomed/panned, keep the view tracking
  // the newest candles as fresh data arrives
  const prevN = useRef(n);
  useEffect(() => {
    if (prevN.current === n) return;
    const old = prevN.current;
    prevN.current = n;
    setView(([s, e]) => (s <= 0.5 && e >= old - 1.5 ? [0, n - 1] : [s, e]));
  }, [n]);

  const clampView = useCallback((s: number, e: number): [number, number] => {
    let span = e - s;
    if (span < MIN_SPAN) { const c = (s + e) / 2; s = c - MIN_SPAN / 2; e = c + MIN_SPAN / 2; span = MIN_SPAN; }
    if (span > n - 1) { s = 0; e = n - 1; span = n - 1; }
    if (s < 0) { e -= s; s = 0; }
    if (e > n - 1) { s -= e - (n - 1); e = n - 1; }
    if (s < 0) s = 0;
    return [s, e];
  }, [n]);

  const svgX = useCallback((clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * W;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (n < 2) return;
    e.preventDefault?.();
    const px = svgX(e.clientX);
    const frac = Math.min(1, Math.max(0, (px - PAD_L) / (W - PAD_L - PAD_R)));
    const [s, e2] = view;
    const anchor = s + frac * (e2 - s);
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    setView(clampView(anchor - (anchor - s) * factor, anchor + (e2 - anchor) * factor));
  }, [n, view, svgX, clampView]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, v0: view[0], v1: view[1] };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [view]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const d = dragRef.current;
    if (d) {
      const pxPerUnit = rect.width / W; // css px per svg unit
      const dIdx = -((e.clientX - d.x) / pxPerUnit) / ((W - PAD_L - PAD_R) / (d.v1 - d.v0));
      setView(clampView(d.v0 + dIdx, d.v1 + dIdx));
      return;
    }
    // hover → crosshair + OHLC readout
    const plotW = W - PAD_L - PAD_R;
    const hNow = PAD_T + PRICE_H + (oscillators.length > 0 ? GAP + OSC_H : 0) + PAD_B;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * hNow;
    if (px < PAD_L || px > PAD_L + plotW || py < PAD_T || py > PAD_T + PRICE_H || n === 0) {
      if (hover) setHover(null);
      return;
    }
    const [s, e2] = view;
    const slot = plotW / (e2 - s + 1);
    const i = Math.round(s + (px - PAD_L) / slot - 0.5);
    setHover({ i: Math.max(0, Math.min(n - 1, i)), y: py });
  }, [clampView, view, n, hover, oscillators.length]);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);
  const onPointerLeave = useCallback(() => { dragRef.current = null; setHover(null); }, []);
  const reset = useCallback(() => setView([0, n - 1]), [n]);

  if (n === 0) {
    return <p className="py-8 text-center text-sm text-muted">داده کندل برای نمایش وجود ندارد.</p>;
  }

  const [vs, ve] = view;
  const lo = Math.max(0, Math.floor(vs));
  const hi = Math.min(n - 1, Math.ceil(ve));
  const hasOsc = oscillators.length > 0;
  const H = PAD_T + PRICE_H + (hasOsc ? GAP + OSC_H : 0) + PAD_B;
  const plotW = W - PAD_L - PAD_R;
  const span = ve - vs + 1;
  const slot = plotW / span;
  const bodyW = Math.max(1, Math.min(slot * 0.7, 12));
  const times = candles.map((c) => c.time);

  // y-domain from visible candles + overlays
  let min = Infinity, max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const c = candles[i];
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  for (const ov of overlays) {
    for (let i = lo; i <= hi && i < ov.values.length; i++) {
      const v = ov.values[i];
      if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  for (const lv of levels) {
    if (lv.price < min) min = lv.price;
    if (lv.price > max) max = lv.price;
  }
  const pad = (max - min) * 0.06 || 1;
  min -= pad; max += pad;

  const x = (i: number) => PAD_L + (i - vs + 0.5) * slot;
  const y = (p: number) => PAD_T + ((max - p) / (max - min)) * PRICE_H;
  const xi = (t: number) => x(nearestIndex(times, t));

  // intraday ranges need clock times on the axis, not just dates
  const intraday = n > 1 && candles[n - 1].time - candles[0].time < 3 * 86_400_000;
  const fmtTick = (t: number) => intraday
    ? new Date(t).toLocaleString("fa-IR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : fmtTime(t);

  const priceTicks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * (i + 0.5)) / 5);
  const timeTicks = Array.from({ length: 5 }, (_, i) => Math.min(n - 1, Math.floor(vs + ((ve - vs) * i) / 4)));

  const oscTop = PAD_T + PRICE_H + GAP;
  const zoomed = vs > 0.5 || ve < n - 1.5;

  return (
    <div className="relative">
      {/* zoom controls */}
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span>اسکرول = زوم · درگ = جابه‌جایی · دابل‌کلیک = بازنشانی</span>
        {zoomed && (
          <button type="button" onClick={reset} className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-accent">
            نمایش کامل
          </button>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair touch-none select-none"
        role="img"
        aria-label="نمودار کندل استیک، اندیکاتورها و معاملات"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={reset}
      >
        {/* clip plot area */}
        <defs>
          <clipPath id="plot"><rect x={PAD_L} y={0} width={plotW} height={H} /></clipPath>
        </defs>

        {/* price grid + axis */}
        {priceTicks.map((p, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={PAD_L + plotW} y1={y(p)} y2={y(p)} stroke="currentColor" className="text-border" strokeDasharray="3 4" strokeWidth={0.5} />
            <text x={PAD_L + plotW + 6} y={y(p) + 4} fontSize={11} fill="currentColor" className="text-muted" direction="ltr" textAnchor="start">
              {fmtPrice(p)}
            </text>
          </g>
        ))}
        {timeTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 8} fontSize={11} fill="currentColor" className="text-muted" textAnchor="middle">
            {fmtTick(candles[i].time)}
          </text>
        ))}

        <g clipPath="url(#plot)">
          {/* candles (visible range only) */}
          {candles.slice(lo, hi + 1).map((c, k) => {
            const i = lo + k;
            const up = c.close >= c.open;
            const color = up ? "#16a34a" : "#dc2626";
            const cx = x(i);
            return (
              <g key={i}>
                <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1} />
                <rect
                  x={cx - bodyW / 2}
                  y={Math.min(y(c.open), y(c.close))}
                  width={bodyW}
                  height={Math.max(1, Math.abs(y(c.open) - y(c.close)))}
                  fill={color}
                />
              </g>
            );
          })}

          {/* indicator overlays */}
          {overlays.map((ov, k) => (
            <path key={k} d={linePoints(ov.values, x, y, lo, hi)} fill="none" stroke={ov.color} strokeWidth={1.4} opacity={0.9} />
          ))}

          {/* trigger levels — prices where orders/exits fire on touch */}
          {levels.map((lv, i) => (
            <g key={`lv-${i}`}>
              <line
                x1={PAD_L} x2={PAD_L + plotW} y1={y(lv.price)} y2={y(lv.price)}
                stroke={lv.color} strokeWidth={1.2} strokeDasharray="6 4" opacity={0.85}
              />
              <text
                x={PAD_L + plotW - 4} y={y(lv.price) - 3} fontSize={10} fill={lv.color}
                textAnchor="end" style={{ paintOrder: "stroke", stroke: "white", strokeWidth: 3 }}
              >
                {lv.label} {fmtPrice(lv.price)}
              </text>
            </g>
          ))}

          {/* signal diamonds — where strategy would fire BUY/SELL */}
          {signals.map((s, i) => {
            const sx = xi(s.time);
            if (sx < PAD_L - 10 || sx > PAD_L + plotW + 10) return null;
            const sy = y(s.price);
            const buy = s.type === "BUY";
            const d = 4.5;
            const cy = buy ? sy + 30 : sy - 30;
            const lbl = `${buy ? "سیگنال خرید" : "سیگنال فروش"} — ${fmtPrice(s.price)}`;
            return (
              <polygon
                key={`sig-${i}`}
                points={`${sx},${cy - d} ${sx + d},${cy} ${sx},${cy + d} ${sx - d},${cy}`}
                fill={buy ? "#22c55e" : "#ef4444"}
                fillOpacity={0.35}
                stroke={buy ? "#16a34a" : "#dc2626"}
                strokeWidth={1.2}
                aria-label={lbl}
              >
                <title>{lbl}</title>
              </polygon>
            );
          })}

          {/* trade paths — dashed entry→exit */}
          {trades.map((t, i) => {
            if (t.exitTime == null || t.exitPrice == null) return null;
            return (
              <line
                key={`path-${i}`}
                x1={xi(t.entryTime)} y1={y(t.entryPrice)}
                x2={xi(t.exitTime)} y2={y(t.exitPrice)}
                stroke={exitColor(t)}
                strokeWidth={1.6}
                strokeDasharray="4 3"
                opacity={0.8}
              />
            );
          })}

          {/* trade markers: entry ▲ · exit ▼ */}
          {trades.map((t, i) => {
            const ex = xi(t.entryTime);
            const ey = y(t.entryPrice);
            return (
              <g key={`m-${i}`}>
                <polygon points={`${ex},${ey + 14} ${ex - 5},${ey + 22} ${ex + 5},${ey + 22}`} fill="#16a34a" stroke="#fff" strokeWidth={1} aria-label={`خرید — ${fmtPrice(t.entryPrice)}`}>
                  <title>{`خرید — ${fmtPrice(t.entryPrice)}`}</title>
                </polygon>
                {t.exitTime != null && t.exitPrice != null && (() => {
                  const xx = xi(t.exitTime);
                  const yy = y(t.exitPrice);
                  const lbl = `${EXIT_STYLE[t.exitReason ?? "SIGNAL"]?.label ?? "خروج"} — ${fmtPrice(t.exitPrice)}${t.pnl != null ? ` · PnL ${fmtPrice(t.pnl)}` : ""}`;
                  return (
                    <polygon points={`${xx},${yy - 14} ${xx - 5},${yy - 22} ${xx + 5},${yy - 22}`} fill={exitColor(t)} stroke="#fff" strokeWidth={1} aria-label={lbl}>
                      <title>{lbl}</title>
                    </polygon>
                  );
                })()}
              </g>
            );
          })}

          {/* hover crosshair — vertical at hovered candle, horizontal at cursor price */}
          {hover && hover.i >= lo && hover.i <= hi && candles[hover.i] && (() => {
            const c = candles[hover.i];
            const hx = x(hover.i);
            const hoverPrice = max - ((hover.y - PAD_T) / PRICE_H) * (max - min);
            return (
              <g pointerEvents="none">
                <line x1={hx} x2={hx} y1={0} y2={H} stroke="currentColor" className="text-muted" strokeWidth={0.7} strokeDasharray="3 3" opacity={0.6} />
                <line x1={PAD_L} x2={PAD_L + plotW} y1={hover.y} y2={hover.y} stroke="currentColor" className="text-muted" strokeWidth={0.7} strokeDasharray="3 3" opacity={0.6} />
                <rect x={hx - Math.max(slot / 2, bodyW / 2 + 2)} y={PAD_T} width={Math.max(slot, bodyW + 4)} height={PRICE_H} fill="none" stroke="currentColor" className="text-muted" strokeWidth={0.7} opacity={0.5} />
                <rect x={PAD_L + plotW + 2} y={hover.y - 8} width={PAD_R - 8} height={16} rx={3} fill={c.close >= c.open ? "#16a34a" : "#dc2626"} />
                <text x={PAD_L + plotW + (PAD_R - 8) / 2 + 2} y={hover.y + 4} fontSize={10} fill="#fff" textAnchor="middle" direction="ltr">{fmtPrice(hoverPrice)}</text>
                <title>{`O ${fmtPrice(c.open)} · H ${fmtPrice(c.high)} · L ${fmtPrice(c.low)} · C ${fmtPrice(c.close)}`}</title>
              </g>
            );
          })()}
        </g>

        {/* hover OHLC readout — top-left of the price pane */}
        {hover && candles[hover.i] && (() => {
          const c = candles[hover.i];
          const txt = `${new Date(c.time).toLocaleString("fa-IR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · باز ${fmtPrice(c.open)} · بالا ${fmtPrice(c.high)} · پایین ${fmtPrice(c.low)} · بسته ${fmtPrice(c.close)}`;
          return (
            <g pointerEvents="none">
              <rect x={PAD_L + 4} y={PAD_T + 4} width={Math.min(plotW - 8, 300)} height={18} rx={4} fill="white" stroke="#cbd5e1" strokeWidth={0.6} opacity={0.95} />
              <text x={PAD_L + 12} y={PAD_T + 17} fontSize={10} fill="#0f172a">{txt}</text>
            </g>
          );
        })()}

        {/* oscillator pane */}
        {oscillators.map((osc, k) => {
          const top = oscTop;
          if (osc.kind === "rsi") {
            const oy = (v: number) => top + ((100 - v) / 100) * OSC_H;
            return (
              <g key={`osc-${k}`}>
                <rect x={PAD_L} y={top} width={plotW} height={OSC_H} fill="none" stroke="currentColor" className="text-border" strokeWidth={0.5} />
                {[30, 70].map((lvl) => (
                  <line key={lvl} x1={PAD_L} x2={PAD_L + plotW} y1={oy(lvl)} y2={oy(lvl)} stroke="currentColor" className="text-border" strokeDasharray="4 4" strokeWidth={0.7} />
                ))}
                <text x={PAD_L + plotW + 6} y={oy(70) + 4} fontSize={10} fill="currentColor" className="text-muted">۷۰</text>
                <text x={PAD_L + plotW + 6} y={oy(30) + 4} fontSize={10} fill="currentColor" className="text-muted">۳۰</text>
                <path d={linePoints(osc.values, x, oy, lo, hi)} fill="none" stroke="#8b5cf6" strokeWidth={1.4} />
                {osc.line && <path d={linePoints(osc.line, x, oy, lo, hi)} fill="none" stroke="#f59e0b" strokeWidth={1.1} />}
                <text x={PAD_L + 6} y={top + 12} fontSize={11} fill="#8b5cf6" fontWeight="bold">{osc.name}</text>
              </g>
            );
          }
          if (osc.kind === "line") {
            let lmin = Infinity, lmax = -Infinity;
            for (let i = lo; i <= hi && i < osc.values.length; i++) {
              const v = osc.values[i];
              if (Number.isFinite(v)) { if (v < lmin) lmin = v; if (v > lmax) lmax = v; }
            }
            for (const b of osc.bands ?? []) {
              if (Number.isFinite(b.v)) { if (b.v < lmin) lmin = b.v; if (b.v > lmax) lmax = b.v; }
            }
            if (!Number.isFinite(lmin) || lmin === lmax) { lmin = 0; lmax = 1; }
            const oy = (v: number) => top + ((lmax - v) / (lmax - lmin)) * OSC_H;
            return (
              <g key={`osc-${k}`}>
                <rect x={PAD_L} y={top} width={plotW} height={OSC_H} fill="none" stroke="currentColor" className="text-border" strokeWidth={0.5} />
                {(osc.bands ?? []).map((b, bi) => (
                  <g key={`band-${bi}`}>
                    <line x1={PAD_L} x2={PAD_L + plotW} y1={oy(b.v)} y2={oy(b.v)} stroke={b.color} strokeDasharray="5 4" strokeWidth={1} opacity={0.8} />
                    <text x={PAD_L + 6} y={oy(b.v) - 3} fontSize={9} fill={b.color}>{b.label} {b.v}</text>
                  </g>
                ))}
                <path d={linePoints(osc.values, x, oy, lo, hi)} fill="none" stroke="#0ea5e9" strokeWidth={1.4} />
                <text x={PAD_L + 6} y={top + 12} fontSize={11} fill="#0ea5e9" fontWeight="bold">{osc.name}</text>
                <text x={PAD_L + plotW + 6} y={oy(lmax)} fontSize={10} fill="currentColor" className="text-muted" direction="ltr">{fmtPrice(lmax)}</text>
                <text x={PAD_L + plotW + 6} y={oy(lmin)} fontSize={10} fill="currentColor" className="text-muted" direction="ltr">{fmtPrice(lmin)}</text>
              </g>
            );
          }
          let omin = Infinity, omax = -Infinity;
          for (const arr of [osc.values, osc.line, osc.signal]) {
            for (let i = lo; i <= hi && arr && i < arr.length; i++) {
              const v = arr[i];
              if (Number.isFinite(v)) { if (v < omin) omin = v; if (v > omax) omax = v; }
            }
          }
          if (!Number.isFinite(omin) || omin === omax) { omin = -1; omax = 1; }
          const oy = (v: number) => top + ((omax - v) / (omax - omin)) * OSC_H;
          const barW = Math.max(1, Math.min(slot * 0.5, 4));
          return (
            <g key={`osc-${k}`}>
              <rect x={PAD_L} y={top} width={plotW} height={OSC_H} fill="none" stroke="currentColor" className="text-border" strokeWidth={0.5} />
              <line x1={PAD_L} x2={PAD_L + plotW} y1={oy(0)} y2={oy(0)} stroke="currentColor" className="text-border" strokeWidth={0.7} />
              {osc.values.slice(lo, hi + 1).map((v, k2) => {
                const i = lo + k2;
                return Number.isFinite(v) ? (
                  <rect
                    key={i}
                    x={x(i) - barW / 2}
                    y={Math.min(oy(0), oy(v))}
                    width={barW}
                    height={Math.max(0.5, Math.abs(oy(v) - oy(0)))}
                    fill={v >= 0 ? "#16a34a" : "#dc2626"}
                    opacity={0.6}
                  />
                ) : null;
              })}
              {osc.line && <path d={linePoints(osc.line, x, oy, lo, hi)} fill="none" stroke="#2563eb" strokeWidth={1.2} />}
              {osc.signal && <path d={linePoints(osc.signal, x, oy, lo, hi)} fill="none" stroke="#f59e0b" strokeWidth={1.2} />}
              <text x={PAD_L + 6} y={top + 12} fontSize={11} fill="#2563eb" fontWeight="bold">{osc.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Legend for candles, overlays, signals and trade markers */
export function CandleChartLegend({
  overlays = [],
  oscillators = [],
  hasTrades = false,
  hasSignals = false,
  levels = [],
}: {
  overlays?: OverlaySeries[];
  oscillators?: OscillatorSeries[];
  hasTrades?: boolean;
  hasSignals?: boolean;
  levels?: PriceLevel[];
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-sm bg-[#16a34a]" /> کندل صعودی</span>
      <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-sm bg-[#dc2626]" /> کندل نزولی</span>
      {overlays.map((o, i) => (
        <span key={i} className="flex items-center gap-1"><span className="inline-block h-0.5 w-5" style={{ background: o.color }} /> {o.name}</span>
      ))}
      {oscillators.map((o, i) => (
        <span key={i} className="flex items-center gap-1"><span className="inline-block h-0.5 w-5 bg-[#8b5cf6]" /> {o.name}</span>
      ))}
      {levels
        .filter((l, i) => levels.findIndex((x) => x.label === l.label && x.color === l.color) === i)
        .map((l, i) => (
          <span key={`lv-${i}`} className="flex items-center gap-1">
            <span className="inline-block h-0 w-6 border-t-2 border-dashed" style={{ borderColor: l.color }} /> {l.label}
          </span>
        ))}
      {hasSignals && (
        <>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rotate-45 border border-[#16a34a] bg-[#22c55e]/40" /> سیگنال خرید</span>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rotate-45 border border-[#dc2626] bg-[#ef4444]/40" /> سیگنال فروش</span>
        </>
      )}
      {hasTrades && (
        <>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-sm bg-[#16a34a]" /> ▲ خرید انجام‌شده</span>
          {Object.entries(EXIT_STYLE).map(([k, s]) => (
            <span key={k} className="flex items-center gap-1"><span className="inline-block size-3 rounded-sm" style={{ background: s.color }} /> ▼ {s.label}</span>
          ))}
          <span className="flex items-center gap-1"><span className="inline-block h-0 w-6 border-t-2 border-dashed border-success" /> مسیر معامله</span>
        </>
      )}
    </div>
  );
}
