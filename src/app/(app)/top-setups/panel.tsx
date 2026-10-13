"use client";

import { useMemo, useState } from "react";
import { Card, CardTitle, Badge, EmptyState, Table } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { SetupDetailDialog } from "./detail";
import { cn, faNumber, faPercent } from "@/shared/utils";
import { jalaliDateTime } from "@/shared/jalali";

export interface ContextRow {
  symbol: string;
  price: number;
  trendRef: "UP" | "DOWN" | "RANGE";
  trend1d: "UP" | "DOWN" | "RANGE";
  volatility: "LOW" | "NORMAL" | "HIGH";
  atrPct: number;
  regime: "AGGRESSIVE" | "NEUTRAL" | "DEFENSIVE";
  summaryFa: string;
  fundingRatePct: number | null;
  openInterestUsd: number | null;
  scannedAt: number;
}

export interface SetupRow {
  id: string;
  symbol: string;
  direction: string;
  kind: string;
  timeframe: string;
  triggerPrice: number;
  confirmRule: string;
  entryLow: number;
  entryHigh: number;
  tp1: number;
  tp2: number;
  sl: number;
  rr: number;
  score: number;
  confidence: number;
  reasonFa: string;
  levelsMeta: Record<string, string>;
  executable: boolean;
  state: string;
  backtestLabel: string;
  rejectionReasons: string[];
  expiresAt: string;
  priceAtScan: number;
}

const REGIME_LABEL: Record<string, { label: string; tone: "success" | "default" | "danger" }> = {
  AGGRESSIVE: { label: "تهاجمی", tone: "success" },
  NEUTRAL: { label: "خنثی", tone: "default" },
  DEFENSIVE: { label: "دفاعی", tone: "danger" },
};
const KIND_LABEL: Record<string, string> = {
  LONG_BREAKOUT: "شکست مقاومت",
  LONG_BOUNCE: "برگشت از حمایت",
  SHORT_BREAKDOWN: "شکست حمایت",
  SHORT_REJECTION: "برگشت از مقاومت",
};
const CONFIRM_LABEL: Record<string, string> = {
  CLOSE_ABOVE_TF: "کلوز بالای سطح",
  CLOSE_BELOW_TF: "کلوز زیر سطح",
  CLOSE_IN_ZONE_BULL_TF: "کلوز صعودی در ناحیه",
  CLOSE_IN_ZONE_BEAR_TF: "کلوز نزولی در ناحیه",
};
const STATE_LABEL: Record<string, string> = {
  PROPOSED: "پیشنهادی",
  BACKTESTED: "بک‌تست‌شده",
  WAITING_TRIGGER: "در انتظار تریگر",
  PAPER_OPEN: "پیپر باز",
  PAPER_CLOSED: "پیپر بسته",
  EXPIRED: "منقضی",
  INVALIDATED: "باطل‌شده",
  REJECTED: "ردشده",
  LIVE_SMALL: "زنده محدود",
  LIVE: "زنده",
};
const BACKTEST_LABEL: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  NOT_TESTED: { label: "بک‌تست‌نشده", tone: "default" },
  VERIFIED: { label: "تأییدشده", tone: "success" },
  INSUFFICIENT: { label: "داده ناکافی", tone: "warning" },
  REJECTED: { label: "ردشده", tone: "danger" },
};
const fmt = (n: number) => {
  const dec = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: dec }).format(n);
};

export function TopSetupsPanel({
  context, setups, lastScanAt, stale, dataFresh, marketType, timeframe,
}: {
  context: ContextRow | null;
  setups: SetupRow[];
  lastScanAt: number | null;
  stale: boolean;
  dataFresh: boolean;
  marketType: string;
  timeframe: string;
}) {
  const [dirFilter, setDirFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const states = useMemo(() => [...new Set(setups.map((s) => s.state))], [setups]);
  const filtered = setups.filter(
    (s) => (dirFilter === "all" || s.direction === dirFilter)
      && (stateFilter === "all" || s.state === stateFilter),
  );

  const regime = context ? REGIME_LABEL[context.regime] : null;

  return (
    <div className="space-y-4">
      {/* market context banner */}
      <Card className={cn(stale || !dataFresh ? "border-amber-300" : "")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-bold">
              زمینه‌ی بازار
              {regime && <Badge tone={regime.tone}>{regime.label}</Badge>}
              {stale && <Badge tone="warning">کهنه</Badge>}
              {!dataFresh && <Badge tone="danger">داده کهنه — تولید متوقف</Badge>}
            </div>
            <div className="text-sm text-muted leading-6">
              {context ? context.summaryFa : "زمینه‌ی بازار در دسترس نیست"}
            </div>
            <div className="text-xs text-muted">
              آخرین اسکن: {lastScanAt ? jalaliDateTime(lastScanAt) : "—"}
              {context?.fundingRatePct != null && ` · فاندینگ ${faNumber(context.fundingRatePct, true)}٪`}
              {context?.openInterestUsd != null && ` · OI ${faNumber(Math.round(context.openInterestUsd / 1e6), true)}M$`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="default">{marketType === "FUTURES" ? "فیوچرز" : "اسپات"} · {timeframe}</Badge>
            <ActionButton endpoint="/api/signal-factory/scan" label="اسکن الان" />
          </div>
        </div>
      </Card>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="text-muted">جهت:</span>
          {[{ v: "all", l: "همه" }, { v: "LONG", l: "لانگ" }, { v: "SHORT", l: "شورت" }].map((o) => (
            <button
              key={o.v}
              onClick={() => setDirFilter(o.v)}
              className={cn(
                "rounded-lg px-3 py-1 font-medium transition",
                dirFilter === o.v ? "bg-primary text-primary-foreground" : "border border-border hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >{o.l}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted">وضعیت:</span>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1"
          >
            <option value="all">همه</option>
            {states.map((s) => <option key={s} value={s}>{STATE_LABEL[s] ?? s}</option>)}
          </select>
        </div>
      </div>

      {/* table */}
      <Card>
        <CardTitle>۱۰ ستاپ برتر</CardTitle>
        {filtered.length === 0 ? (
          <EmptyState
            title="امروز ستاپ مناسبی نیست"
            hint={setups.length ? "فیلترها را تغییر دهید" : "بعد از اسکن بعدی دوباره بررسی کنید — کیفیت مقدم بر تعداد است"}
          />
        ) : (
          <Table headers={["جفت", "نوع", "جهت", "ورود", "شرط تأیید", "TP1", "TP2", "SL", "R:R", "امتیاز", "بک‌تست", "وضعیت", "انقضا"]}>
            {filtered.map((s) => (
                <tr key={s.id}
                  onClick={() => setDetailId(s.id)}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <td className="px-4 py-3 font-bold ltr whitespace-nowrap">{s.symbol}</td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">{KIND_LABEL[s.kind] ?? s.kind}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge tone={s.direction === "LONG" ? "success" : "danger"}>
                      {s.direction === "LONG" ? "لانگ" : "شورت"}
                    </Badge>
                    {!s.executable && <Badge tone="warning">غیرقابل اجرا</Badge>}
                  </td>
                  <td className="px-4 py-3 ltr text-xs whitespace-nowrap">{fmt(s.entryLow)} – {fmt(s.entryHigh)}</td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">{CONFIRM_LABEL[s.confirmRule] ?? s.confirmRule}</td>
                  <td className="px-4 py-3 ltr text-xs">{fmt(s.tp1)}</td>
                  <td className="px-4 py-3 ltr text-xs">{fmt(s.tp2)}</td>
                  <td className="px-4 py-3 ltr text-xs">{fmt(s.sl)}</td>
                  <td className="px-4 py-3 ltr font-bold">{faNumber(s.rr, true)}</td>
                  <td className="px-4 py-3">
                    <span className={cn("font-bold", s.score >= 60 ? "text-success" : s.score >= 35 ? "text-amber-600" : "text-muted")}>
                      {faNumber(s.score)}
                    </span>
                    <span className="text-xs text-muted"> ({faPercent(s.confidence * 100)})</span>
                  </td>
                  <td className="px-4 py-3"><Badge tone={BACKTEST_LABEL[s.backtestLabel]?.tone ?? "default"}>{BACKTEST_LABEL[s.backtestLabel]?.label ?? s.backtestLabel}</Badge></td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">{STATE_LABEL[s.state] ?? s.state}</td>
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(s.expiresAt)}</td>
                </tr>
            ))}
          </Table>
        )}
      </Card>

      {detailId && <SetupDetailDialog id={detailId} onClose={() => setDetailId(null)} />}

      <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <div className="text-sm leading-6 text-amber-800 dark:text-amber-200">
          <b>یادآوری:</b> ستاپ‌ها پیش‌بینی قطعی نیستند — سناریوهای شرطی با سطح مشخص‌اند که
          فقط در صورت تأیید تریگر فعال می‌شوند. قوانین ریسک سیستم همیشه برترند.
        </div>
      </Card>
    </div>
  );
}
