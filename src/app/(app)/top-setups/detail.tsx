"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { ActionButton, Spinner } from "@/components/client";
import { cn, faNumber, faPercent } from "@/shared/utils";
import { jalaliDateTime } from "@/shared/jalali";

interface Metrics {
  totalTrades?: number;
  profitFactor?: number;
  expectancy?: number;
  maxDrawdownPct?: number;
  winRate?: number;
}

interface PaperTradeRow {
  status: string;
  side: string;
  entryPrice: number;
  invested: number;
  tp1: number;
  tp2: number;
  sl: number;
  tp1Hit: boolean;
  exitPrice: number | null;
  exitReason: string | null;
  pnl: number | null;
  pnlPct: number | null;
  costsPct: number;
  openedAt: string;
  closedAt: string | null;
}

interface Detail {
  setup: {
    id: string; symbol: string; direction: string; kind: string; timeframe: string;
    state: string; backtestLabel: string; outcome: string | null; outcomePnlPct: number | null;
    reasonFa: string; score: number; confidence: number; rr: number;
    triggerPrice: number; entryLow: number; entryHigh: number;
    tp1: number; tp2: number; sl: number; invalidatePrice: number;
    levelsMeta: Record<string, string>; executable: boolean;
    expiresAt: string; createdAt: string; priceAtScan: number;
    paperTrade: PaperTradeRow | null;
  };
  backtest: {
    passed: boolean; reasons: string[]; train: Metrics | null; test: Metrics | null;
    feePct: number; slippagePct: number; startDate: string; endDate: string;
  } | null;
  peers: { symbol: string; passed: boolean; test: Metrics | null }[];
  history: { at: string; type: string; summary: string; reason: string | null }[];
  live: {
    typeKey: string;
    checklistOk: boolean;
    missing: string[];
    liveApproved: boolean;
    liveSizeScale: number;
  };
  sparkline: number[];
}

const KIND_LABEL: Record<string, string> = {
  LONG_BREAKOUT: "شکست مقاومت",
  LONG_BOUNCE: "برگشت از حمایت",
  SHORT_BREAKDOWN: "شکست حمایت",
  SHORT_REJECTION: "برگشت از مقاومت",
};
const STATE_LABEL: Record<string, string> = {
  PROPOSED: "پیشنهادی", BACKTESTED: "بک‌تست‌شده", WAITING_TRIGGER: "در انتظار تریگر",
  PAPER_OPEN: "پیپر باز", PAPER_CLOSED: "پیپر بسته", EXPIRED: "منقضی",
  INVALIDATED: "باطل‌شده", REJECTED: "ردشده", LIVE_SMALL: "زنده محدود", LIVE: "زنده",
};
const OUTCOME_LABEL: Record<string, { label: string; tone: "success" | "danger" | "warning" | "default" }> = {
  TP1_HIT: { label: "TP1 زده شد", tone: "success" },
  TP2_HIT: { label: "TP2 زده شد", tone: "success" },
  SL_HIT: { label: "استاپ خورد", tone: "danger" },
  EXPIRED: { label: "منقضی", tone: "warning" },
  INVALIDATED: { label: "باطل‌شده", tone: "warning" },
};
const META_LABEL: Record<string, string> = {
  trigger: "تریگر", entry: "ورود", sl: "استاپ", tp1: "TP1", tp2: "TP2", invalidate: "ابطال",
};
const EXIT_FA: Record<string, string> = { TP2_HIT: "هدف دوم", SL_HIT: "استاپ", EXPIRED: "انقضا", PARTIAL_TP: "TP1" };

const fmt = (n: number) => {
  const dec = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: dec }).format(n);
};

function Sparkline({ values, levels }: { values: number[]; levels: { v: number; color: string }[] }) {
  if (values.length < 2) return <div className="text-xs text-muted">داده‌ی کندل در دسترس نیست</div>;
  const w = 560, h = 110, pad = 6;
  const all = [...values, ...levels.map((l) => l.v)];
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = values.at(-1)! >= values[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: 110, direction: "ltr" }}>
      {levels.map((l, i) => (
        <line key={i} x1={pad} x2={w - pad} y1={y(l.v)} y2={y(l.v)} stroke={l.color}
          strokeWidth="1" strokeDasharray="4 3" opacity="0.6" />
      ))}
      <polyline points={pts} fill="none" strokeWidth="1.6"
        className={up ? "stroke-emerald-500" : "stroke-red-500"} />
    </svg>
  );
}

function Metric({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/50">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="text-xs font-black" dir="ltr">{v}</div>
    </div>
  );
}

export function SetupDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setD(null); setError(false);
    fetch(`/api/signal-factory/setups/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setD)
      .catch(() => setError(true));
  }, [id]);

  const s = d?.setup;
  const pt = s?.paperTrade;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {!d && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-muted">
            <Spinner className="size-6" /> در حال بارگذاری…
          </div>
        )}
        {error && <div className="py-16 text-center text-sm text-danger">بارگذاری جزئیات ناموفق بود</div>}
        {d && s && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-black" dir="ltr">{s.symbol}</span>
              <Badge tone={s.direction === "LONG" ? "success" : "danger"}>
                {s.direction === "LONG" ? "لانگ" : "شورت"}
              </Badge>
              <Badge tone="info">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
              <Badge tone="default">{STATE_LABEL[s.state] ?? s.state}</Badge>
              {s.outcome && (
                <Badge tone={OUTCOME_LABEL[s.outcome]?.tone ?? "default"}>
                  {OUTCOME_LABEL[s.outcome]?.label ?? s.outcome}
                  {s.outcomePnlPct != null && ` ${faPercent(s.outcomePnlPct)}`}
                </Badge>
              )}
              {!s.executable && <Badge tone="warning">غیرقابل اجرا (تحلیلی)</Badge>}
              <span className="ms-auto text-xs text-muted">{s.timeframe} · امتیاز {faNumber(s.score)} · R:R {faNumber(s.rr, true)}</span>
              <button onClick={onClose} className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
            </div>

            <div className="rounded-xl border border-border p-3">
              <Sparkline
                values={d.sparkline}
                levels={[
                  { v: s.tp2, color: "#059669" }, { v: s.tp1, color: "#34d399" },
                  { v: s.triggerPrice, color: "#3b82f6" }, { v: s.sl, color: "#ef4444" },
                ]}
              />
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted">
                <span className="text-emerald-600">— TP2</span>
                <span className="text-emerald-400">— TP1</span>
                <span className="text-blue-500">— تریگر</span>
                <span className="text-red-500">— SL</span>
              </div>
            </div>

            <div>
              <div className="text-sm font-bold">دلیل ستاپ</div>
              <div className="mt-1 text-sm leading-6">{s.reasonFa}</div>
            </div>

            <div>
              <div className="text-sm font-bold">سطوح و منشأ هر یک</div>
              <div className="mt-1 grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-3">
                {([
                  ["تریگر", fmt(s.triggerPrice), s.levelsMeta.trigger],
                  ["ورود", `${fmt(s.entryLow)} – ${fmt(s.entryHigh)}`, s.levelsMeta.entry],
                  ["TP1", fmt(s.tp1), s.levelsMeta.tp1],
                  ["TP2", fmt(s.tp2), s.levelsMeta.tp2],
                  ["استاپ", fmt(s.sl), s.levelsMeta.sl],
                  ["ابطال", fmt(s.invalidatePrice), s.levelsMeta.invalidate],
                ] as const).map(([label, price, src]) => (
                  <div key={label} className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/50">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="text-[10px] text-muted">{label}</span>
                      <span className="font-black" dir="ltr">{price}</span>
                    </div>
                    <div className="text-[10px] text-muted">{src ?? "—"}</div>
                  </div>
                ))}
              </div>
            </div>

            {pt && (
              <div className={cn("rounded-xl border p-3", pt.status === "OPEN" ? "border-blue-300" : "border-border")}>
                <div className="flex items-center gap-2 text-sm font-bold">
                  معامله‌ی پیپر
                  <Badge tone={pt.status === "OPEN" ? "info" : "default"}>{pt.status === "OPEN" ? "باز" : "بسته"}</Badge>
                  {pt.tp1Hit && pt.status === "OPEN" && <Badge tone="success">TP1 بانک شد — استاپ سر به سر</Badge>}
                  {pt.pnlPct != null && (
                    <span className={cn("font-black", pt.pnlPct >= 0 ? "text-success" : "text-danger")}>{faPercent(pt.pnlPct)}</span>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5 text-center sm:grid-cols-5">
                  <Metric label="ورود" v={fmt(pt.entryPrice)} />
                  <Metric label="سرمایه" v={fmt(pt.invested)} />
                  <Metric label="هزینه" v={faPercent(pt.costsPct)} />
                  <Metric label="SL فعلی" v={fmt(pt.sl)} />
                  <Metric label="خروج" v={pt.exitPrice != null ? `${fmt(pt.exitPrice)} (${EXIT_FA[pt.exitReason ?? ""] ?? pt.exitReason})` : "—"} />
                </div>
                <div className="mt-1 text-[10px] text-muted">
                  باز شد: {jalaliDateTime(pt.openedAt)}{pt.closedAt ? ` · بسته شد: ${jalaliDateTime(pt.closedAt)}` : ""}
                </div>
              </div>
            )}

            <div>
              <div className="text-sm font-bold">نتیجه‌ی بک‌تست الگو</div>
              {d.backtest ? (
                <div className="mt-1 space-y-1.5">
                  <div className="grid grid-cols-3 gap-1.5 text-center sm:grid-cols-5">
                    <Metric label="معاملات تست" v={faNumber(d.backtest.test?.totalTrades ?? 0)} />
                    <Metric label="PF تست" v={d.backtest.test?.profitFactor?.toFixed(2) ?? "—"} />
                    <Metric label="Expectancy تست" v={d.backtest.test?.expectancy != null ? faPercent(d.backtest.test.expectancy) : "—"} />
                    <Metric label="حداکثر DD" v={d.backtest.test?.maxDrawdownPct != null ? faPercent(d.backtest.test.maxDrawdownPct) : "—"} />
                    <Metric label="هزینه" v={faPercent(d.backtest.feePct + d.backtest.slippagePct)} />
                  </div>
                  {d.backtest.reasons.length > 0 && (
                    <div className="text-xs text-muted">{d.backtest.reasons.join("؛ ")}</div>
                  )}
                  {d.peers.length > 0 && (
                    <div className="text-[10px] text-muted">
                      جفت‌های مشابه: {d.peers.map((p) => `${p.symbol} (${p.passed ? "✓" : "✗"})`).join("، ")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-1 text-xs text-muted">هنوز بک‌تست نشده — در صف backtest-runner</div>
              )}
            </div>

            <div className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                ارتقا به معامله‌ی زنده
                {d.live.liveApproved && (
                  <Badge tone="success">تأییدشده — سایز {faPercent(d.live.liveSizeScale * 100)}</Badge>
                )}
              </div>
              {d.live.liveApproved ? (
                <div className="mt-1 text-xs leading-5 text-muted">
                  این الگو برای معامله‌ی واقعی تأیید شده — پس از تأیید تریگر، سفارش واقعی با سایز محدود ثبت می‌شود و استاپ به‌صورت مانیتورشده (هر دقیقه) مدیریت می‌گردد.
                </div>
              ) : d.live.checklistOk ? (
                <div className="mt-2 space-y-2">
                  <div className="text-xs leading-5 text-muted">
                    همه‌ی پیش‌نیازها برقرار است — با تأیید، ستاپ‌های این الگو با سفارش واقعی و ۲۵٪ سایز اجرا می‌شوند.
                  </div>
                  <ActionButton
                    endpoint="/api/signal-factory/approve"
                    payload={{ typeKey: d.live.typeKey }}
                    label="تأیید ارتقا به زنده محدود"
                    confirm="ارتقای این الگو به معامله‌ی واقعی با ۲۵٪ سایز را تأیید می‌کنید؟ قوانین ریسک سیستم همچنان اعمال می‌شوند."
                  />
                </div>
              ) : (
                <ul className="mt-1 space-y-1 text-xs leading-5">
                  <li className="font-bold text-amber-600">پیش‌نیازهای باقی‌مانده برای ارتقا:</li>
                  {d.live.missing.map((m) => (
                    <li key={m} className="text-muted">• {m}</li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-sm font-bold">تاریخچه‌ی چرخه‌ی عمر</div>
              {d.history.length ? (
                <ol className="mt-1 space-y-1 border-s-2 border-border ps-3 text-xs">
                  {d.history.map((h, i) => (
                    <li key={i}>
                      <span className="text-muted" dir="ltr">{jalaliDateTime(h.at)}</span> — {h.summary}
                      {h.reason && <div className="text-muted">{h.reason}</div>}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="mt-1 text-xs text-muted">رویدادی ثبت نشده — ستاپ هنوز تازه است</div>
              )}
            </div>

            <div className="text-[10px] text-muted">
              ساخته‌شده: {jalaliDateTime(s.createdAt)} · انقضا: {jalaliDateTime(s.expiresAt)} ·
              قیمت در زمان اسکن: <span dir="ltr">{fmt(s.priceAtScan)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
