"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandleChart, CandleChartLegend,
  type ChartCandle, type TradeMark, type OverlaySeries, type OscillatorSeries,
  type SignalMark, type PriceLevel,
} from "./candle-chart";
import { HELP_TIP_EVENT } from "./client";
import { cn, faNumber } from "@/shared/utils";

interface WatchLine {
  tone: "buy" | "sell" | "info";
  text: string;
}

interface SignalWatch {
  price: number | null;
  signal: string;
  score: number | null;
  label: string | null;
  state: string;
  lines: WatchLine[];
}

interface ChartPayload {
  candles: ChartCandle[];
  trades: TradeMark[];
  overlays: OverlaySeries[];
  oscillators: OscillatorSeries[];
  signals: SignalMark[];
  levels: PriceLevel[];
  kind: string;
  mode: string;
  watch?: SignalWatch;
}

const POLL_MS = 15_000;

const SIGNAL_TONE: Record<string, string> = {
  BUY: "border-success/50 bg-success/10 text-success",
  SELL: "border-danger/50 bg-danger/10 text-danger",
  HOLD: "border-border bg-card text-muted",
};
const SIGNAL_FA: Record<string, string> = { BUY: "خرید", SELL: "فروش", HOLD: "انتظار" };

let watchSeq = 0;

/** "؟"-style trigger icon — popover explains when the engine buys/sells, with live values. */
function WatchTip({ watch }: { watch: SignalWatch }) {
  const [open, setOpen] = useState(false);
  const idRef = useRef(++watchSeq);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== idRef.current) setOpen(false);
    };
    window.addEventListener(HELP_TIP_EVENT, onOther);
    return () => window.removeEventListener(HELP_TIP_EVENT, onOther);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dot = (tone: WatchLine["tone"]) =>
    tone === "buy" ? "bg-success" : tone === "sell" ? "bg-danger" : "bg-muted-foreground/50";

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="شرایط ورود و خروج"
        aria-expanded={open}
        title="کی وارد معامله می‌شود؟"
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => {
            if (!v) window.dispatchEvent(new CustomEvent<number>(HELP_TIP_EVENT, { detail: idRef.current }));
            return !v;
          });
        }}
        className={cn(
          "inline-flex size-[18px] items-center justify-center rounded-full border text-[11px] font-bold leading-none transition-all",
          open
            ? "scale-110 border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/40"
            : "border-primary/50 text-primary hover:border-primary hover:bg-primary/10",
        )}
      >
        ؟
      </button>
      {open && (
        <span
          className="absolute end-0 top-full z-30 mt-2 block w-80 max-w-[85vw] origin-top"
          style={{ animation: "helptip-in .15s ease-out" }}
        >
          <span className="absolute -top-[5px] end-2.5 size-2.5 rotate-45 border-s border-t border-primary/25 bg-card" />
          <span className="relative block overflow-hidden rounded-2xl border border-primary/25 bg-card/95 shadow-xl shadow-primary/10 backdrop-blur-md">
            <span className="flex items-center gap-1.5 border-b border-border/60 bg-primary/5 px-3 py-1.5 text-[10px] font-bold text-primary">
              <span className="size-1.5 rounded-full bg-primary" />
              شرایط ورود و خروج
            </span>
            <span className="block px-3 py-2.5 text-start text-xs leading-6 text-foreground/90">
              <span className="mb-1 block font-bold">{watch.state}</span>
              {watch.lines.map((l, i) => (
                <span key={i} className="flex items-start gap-1.5">
                  <span className={cn("mt-2 size-1.5 shrink-0 rounded-full", dot(l.tone))} />
                  <span>{l.text}</span>
                </span>
              ))}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Live chart for a running strategy — polls /api/live/[id]/chart and
 * re-renders candles, quote lines, signal marks and trade markers as
 * the worker ticks land. Stops polling once the strategy is inactive.
 */
export function LiveChart({ liveId, active }: { liveId: string; active: boolean }) {
  const [data, setData] = useState<ChartPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/live/${liveId}/chart`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as ChartPayload;
        if (!dead) { setData(j); setFailed(false); setAt(Date.now()); }
      } catch {
        if (!dead) setFailed(true);
      }
    };
    void load();
    if (!active) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => { dead = true; clearInterval(t); };
  }, [liveId, active]);

  if (failed && !data) {
    return <p className="py-4 text-center text-xs text-muted">دریافت داده‌ی نمودار ناموفق بود.</p>;
  }
  if (!data) {
    return <p className="py-6 text-center text-xs text-muted">در حال بارگذاری نمودار…</p>;
  }

  // MM quotes repeat the same name per level — dedupe for the legend
  const legendOverlays = data.overlays.filter(
    (o, i) => data.overlays.findIndex((x) => x.name === o.name) === i,
  );

  const w = data.watch;

  return (
    <div>
      {w && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 font-bold">
            قیمت فعلی
            <b className="ltr text-sm">{faNumber(w.price, true)}</b>
          </span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-bold",
              SIGNAL_TONE[w.signal] ?? SIGNAL_TONE.HOLD,
            )}
          >
            {SIGNAL_FA[w.signal] ?? w.signal}
            {w.score !== null ? ` · ${faNumber(w.score, true)}` : ""}
          </span>
          {w.label && <span className="text-muted">{w.label}</span>}
          <span className="text-muted">{w.state}</span>
          <span className="ms-auto"><WatchTip watch={w} /></span>
        </div>
      )}
      <CandleChart
        candles={data.candles}
        trades={data.trades}
        overlays={data.overlays}
        oscillators={data.oscillators}
        signals={data.signals}
        levels={data.levels}
      />
      <CandleChartLegend
        overlays={legendOverlays}
        oscillators={data.oscillators}
        hasTrades={data.trades.length > 0}
        hasSignals={data.signals.length > 0}
        levels={data.levels}
      />
      {active && at && (
        <p className="mt-1 text-[10px] text-muted">
          به‌روزرسانی خودکار هر {POLL_MS / 1000} ثانیه · آخرین بار:{" "}
          {new Date(at).toLocaleTimeString("fa-IR")}
        </p>
      )}
    </div>
  );
}
