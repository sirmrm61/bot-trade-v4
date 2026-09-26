"use client";

import { useEffect, useState } from "react";
import {
  CandleChart, CandleChartLegend,
  type ChartCandle, type TradeMark, type OverlaySeries, type OscillatorSeries,
  type SignalMark, type PriceLevel,
} from "./candle-chart";

interface ChartPayload {
  candles: ChartCandle[];
  trades: TradeMark[];
  overlays: OverlaySeries[];
  oscillators: OscillatorSeries[];
  signals: SignalMark[];
  levels: PriceLevel[];
  kind: string;
  mode: string;
}

const POLL_MS = 15_000;

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

  return (
    <div>
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
