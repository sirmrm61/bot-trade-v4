"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Spinner, Field, Select, Input } from "@/components/client";
import { Badge, EmptyState } from "@/components/ui";
import { toast } from "@/components/toast";
import { cn } from "@/shared/utils";

interface Opportunity {
  id: string;
  exchange: string;
  symbol: string;
  marketType: string;
  direction: "LONG" | "SHORT";
  timeframe: string;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  grossReturnPct: number;
  totalCostPct: number;
  netReturnPct: number;
  riskReward: number;
  score: number;
  reasons: string;
  status: "OPEN" | "EXPIRED" | "EXECUTED";
  outcome: string | null;
  outcomePnlPct: number | null;
  createdAt: string;
  expiresAt: string;
}

interface BacktestResult {
  totalSignals: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;
  candles: number;
  symbol: string;
  timeframe: string;
  days: number;
}

const OUTCOME_LABEL: Record<string, { label: string; tone: "success" | "danger" | "warning" | "default" }> = {
  TP_HIT: { label: "حد سود", tone: "success" },
  SL_HIT: { label: "حد ضرر", tone: "danger" },
  TIMEOUT: { label: "پایان مهلت", tone: "warning" },
  NO_DATA: { label: "بدون داده", tone: "default" },
};

const fmt = (v: number) => (Math.abs(v) >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v.toFixed(6));

export function ScannerDialog({ pairs }: { pairs: { symbol: string; exchange: string }[] }) {
  const [market, setMarket] = useState("");
  const [timeframe, setTimeframe] = useState("5m");
  const [count, setCount] = useState("10");
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<Opportunity[]>([]);
  const [history, setHistory] = useState<Opportunity[]>([]);
  const [execId, setExecId] = useState<string | null>(null);
  const [capital, setCapital] = useState("100");
  const [execMode, setExecMode] = useState<"PAPER" | "REAL">("PAPER");
  const [executing, setExecuting] = useState(false);
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btRunning, setBtRunning] = useState(false);
  const [btSymbol, setBtSymbol] = useState("");
  const [btExchange, setBtExchange] = useState("KUCOIN");
  const [btDays, setBtDays] = useState("14");

  // unique symbols for the datalist; picking one auto-sets its exchange
  const symbols = useMemo(() => [...new Set(pairs.map((p) => p.symbol))].sort(), [pairs]);
  function pickSymbol(v: string) {
    setBtSymbol(v);
    const hit = pairs.find((p) => p.symbol === v.toUpperCase().trim());
    if (hit) setBtExchange(hit.exchange);
  }

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/opportunities?take=20");
      const json = await res.json();
      if (res.ok) setHistory(json.items ?? []);
    } catch { /* silent — history is best-effort */ }
  }, []);

  useEffect(() => {
    fetch("/api/opportunities?take=20")
      .then((r) => r.json())
      .then((j) => { if (j.items) setHistory(j.items); })
      .catch(() => {});
  }, []);

  async function scan() {
    setScanning(true);
    try {
      const res = await fetch("/api/opportunities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: market || undefined,
          count: Number(count) || 10,
          candleTimeframe: timeframe,
        }),
      });
      const json = await res.json();
      if (!res.ok) toast.error(json.error ?? "اسکن ناموفق بود");
      else {
        setResults(json.opportunities ?? []);
        toast.success(`${json.created} فرصت از ${json.ranked} جفت بررسی‌شده پیدا شد`);
        void loadHistory();
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد");
    } finally {
      setScanning(false);
    }
  }

  async function execute(id: string) {
    setExecuting(true);
    try {
      const res = await fetch(`/api/opportunities/${id}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: execMode, allocatedCapital: Number(capital) }),
      });
      const json = await res.json();
      if (!res.ok) toast.error(json.error ?? "اجرای فرصت ناموفق بود");
      else {
        toast.success(execMode === "PAPER" ? "تست زنده فعال شد" : "معامله‌ی زنده فعال شد");
        setExecId(null);
        void loadHistory();
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد");
    } finally {
      setExecuting(false);
    }
  }

  async function runBacktest() {
    if (!btSymbol.trim()) { toast.error("نماد را وارد کنید"); return; }
    setBtRunning(true);
    setBt(null);
    try {
      const res = await fetch("/api/opportunities/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: btSymbol.trim().toUpperCase(),
          exchange: btExchange,
          timeframe,
          days: Number(btDays) || 14,
        }),
      });
      const json = await res.json();
      if (!res.ok) toast.error(json.error ?? "بک‌تست ناموفق بود");
      else setBt(json);
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد");
    } finally {
      setBtRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* scan controls */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="بازار">
          <Select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">همه</option>
            <option value="SPOT">اسپات</option>
            <option value="PERPETUAL">پرپچوال</option>
          </Select>
        </Field>
        <Field label="تایم‌فریم">
          <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
            {["1m", "3m", "5m", "15m", "30m", "1h"].map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="حداکثر فرصت">
          <Input type="number" min={1} max={25} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <button
            type="button"
            onClick={scan}
            disabled={scanning}
            className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {scanning ? <span className="inline-flex items-center gap-2"><Spinner />در حال اسکن…</span> : "شروع اسکن"}
          </button>
        </div>
      </div>

      {/* scan results */}
      {scanning ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-10">
          <Spinner className="size-8" />
          <span className="text-sm text-muted">در حال بررسی جفت‌ارزها، اوردر‌بوک و کندل‌ها…</span>
        </div>
      ) : results.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-bold">فرصت‌های تازه</h4>
          {results.map((o) => (
            <OpportunityCard key={o.id} o={o}
              executing={executing} execId={execId} setExecId={setExecId}
              capital={capital} setCapital={setCapital}
              execMode={execMode} setExecMode={setExecMode}
              onExecute={execute} />
          ))}
        </div>
      ) : null}

      {/* scanner backtest */}
      <div className="rounded-xl border border-border p-4">
        <h4 className="mb-3 text-sm font-bold">بک‌تست اسکنر — همان منطق روی داده‌ی تاریخی</h4>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="نماد">
            <Input dir="ltr" list="bt-symbols" placeholder="BTC-USDT" value={btSymbol} onChange={(e) => pickSymbol(e.target.value)} />
            <datalist id="bt-symbols">
              {symbols.map((s) => <option key={s} value={s} />)}
            </datalist>
          </Field>
          <Field label="صرافی">
            <Select value={btExchange} onChange={(e) => setBtExchange(e.target.value)}>
              <option value="KUCOIN">کوکوین</option>
              <option value="NOBITEX">نوبیتکس</option>
            </Select>
          </Field>
          <Field label="روز"><Input type="number" min={3} max={90} value={btDays} onChange={(e) => setBtDays(e.target.value)} /></Field>
          <div className="flex items-end">
            <button type="button" onClick={runBacktest} disabled={btRunning}
              className="w-full rounded-xl border border-primary px-4 py-2 text-sm font-bold text-primary transition hover:bg-primary/5 disabled:opacity-50">
              {btRunning ? <span className="inline-flex items-center gap-2"><Spinner />در حال پخش…</span> : "بک‌تست"}
            </button>
          </div>
        </div>
        {bt && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-6">
            <Stat label="سیگنال" v={bt.totalSignals} />
            <Stat label="برد" v={bt.wins} tone="success" />
            <Stat label="باخت" v={bt.losses} tone="danger" />
            <Stat label="وین‌ریت" v={`${bt.winRate.toFixed(0)}٪`} />
            <Stat label="میانگین PnL" v={`${bt.avgPnlPct.toFixed(2)}٪`} tone={bt.avgPnlPct >= 0 ? "success" : "danger"} />
            <Stat label="PnL کل" v={`${bt.totalPnlPct.toFixed(1)}٪`} tone={bt.totalPnlPct >= 0 ? "success" : "danger"} />
          </div>
        )}
      </div>

      {/* history */}
      <div>
        <h4 className="mb-2 text-sm font-bold">تاریخچه‌ی فرصت‌ها</h4>
        {history.length === 0 ? (
          <EmptyState title="هنوز فرصتی ثبت نشده" hint="اسکن را اجرا کنید تا فرصت‌ها اینجا ذخیره شوند" />
        ) : (
          <div className="space-y-1.5">
            {history.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                <span className="font-bold" dir="ltr">{o.symbol}</span>
                <Badge tone={o.direction === "LONG" ? "success" : "danger"}>{o.direction === "LONG" ? "لانگ" : "شورت"}</Badge>
                <span className="text-muted">{o.netReturnPct > 0 ? "+" : ""}{o.netReturnPct}٪ خالص</span>
                <span className="text-muted">امتیاز {o.score}</span>
                {o.outcome && OUTCOME_LABEL[o.outcome]
                  ? <Badge tone={OUTCOME_LABEL[o.outcome].tone}>{OUTCOME_LABEL[o.outcome].label} {o.outcomePnlPct !== null ? `(${o.outcomePnlPct > 0 ? "+" : ""}${o.outcomePnlPct}٪)` : ""}</Badge>
                  : <Badge tone={o.status === "OPEN" ? "info" : o.status === "EXECUTED" ? "success" : "default"}>
                      {o.status === "OPEN" ? "باز" : o.status === "EXECUTED" ? "اجرا شده" : "منقضی"}
                    </Badge>}
                <span className="text-muted" dir="ltr">{new Date(o.createdAt).toLocaleString("fa-IR")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: React.ReactNode; tone?: "success" | "danger" }) {
  const cls = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "";
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/50">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={cn("text-sm font-black", cls)}>{v}</div>
    </div>
  );
}

function OpportunityCard({ o, execId, setExecId, capital, setCapital, execMode, setExecMode, executing, onExecute }: {
  o: Opportunity;
  execId: string | null; setExecId: (v: string | null) => void;
  capital: string; setCapital: (v: string) => void;
  execMode: "PAPER" | "REAL"; setExecMode: (v: "PAPER" | "REAL") => void;
  executing: boolean;
  onExecute: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const reasons = (() => { try { return JSON.parse(o.reasons) as string[]; } catch { return []; } })();
  const shortOnSpot = o.direction === "SHORT" && o.marketType !== "PERPETUAL";

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-black" dir="ltr">{o.symbol}</span>
        <Badge tone="info">{o.exchange}</Badge>
        <Badge tone={o.direction === "LONG" ? "success" : "danger"}>{o.direction === "LONG" ? "لانگ" : "شورت"}</Badge>
        <Badge tone="default">{o.marketType === "PERPETUAL" ? "پرپچوال" : "اسپات"}</Badge>
        <span className="ms-auto flex items-center gap-1 text-xs">
          <span className="text-muted">اعتماد</span>
          <span className={cn("font-black", o.score >= 60 ? "text-success" : o.score >= 40 ? "text-warning" : "text-danger")}>{o.score}</span>
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center sm:grid-cols-6">
        <Stat label="ورود" v={fmt(o.entryPrice)} />
        <Stat label="حد سود" v={fmt(o.takeProfitPrice)} tone="success" />
        <Stat label="حد ضرر" v={fmt(o.stopLossPrice)} tone="danger" />
        <Stat label="بازده ناخالص" v={`${o.grossReturnPct}٪`} />
        <Stat label="هزینه" v={`${o.totalCostPct}٪`} />
        <Stat label="خالص / RR" v={`${o.netReturnPct}٪ · ${o.riskReward}`} tone={o.netReturnPct >= 0 ? "success" : "danger"} />
      </div>

      {expanded && reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pe-4 text-xs text-muted">
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="text-xs font-bold text-primary hover:underline">
          {expanded ? "بستن دلایل ↑" : "دلایل سیگنال ↓"}
        </button>
        <span className="ms-auto flex items-center gap-2">
          {shortOnSpot ? (
            <span className="text-[11px] text-muted">شورت روی اسپات قابل اجرا نیست</span>
          ) : execId === o.id ? (
            <span className="flex flex-wrap items-center gap-2">
              <Select value={execMode} onChange={(e) => setExecMode(e.target.value as "PAPER" | "REAL")} className="!w-auto py-1 text-xs">
                <option value="PAPER">تست زنده</option>
                <option value="REAL">واقعی</option>
              </Select>
              <Input type="number" value={capital} onChange={(e) => setCapital(e.target.value)}
                className="!w-24 py-1 text-xs" placeholder="سرمایه $" dir="ltr" />
              <button type="button" onClick={() => onExecute(o.id)} disabled={executing}
                className={cn("rounded-lg px-3 py-1 text-xs font-bold text-white disabled:opacity-50", execMode === "REAL" ? "bg-danger" : "bg-success")}>
                {executing ? <Spinner /> : execMode === "REAL" ? "تأیید معامله‌ی واقعی" : "شروع تست"}
              </button>
              <button type="button" onClick={() => setExecId(null)} className="text-xs text-muted">لغو</button>
            </span>
          ) : (
            <button type="button" onClick={() => setExecId(o.id)}
              className="rounded-lg bg-primary px-3 py-1 text-xs font-bold text-primary-foreground hover:opacity-90">
              اجرای فرصت
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
