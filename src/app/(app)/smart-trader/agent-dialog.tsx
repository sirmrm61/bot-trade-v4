"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Spinner, Field, Select } from "@/components/client";
import { Badge, EmptyState } from "@/components/ui";
import { toast } from "@/components/toast";
import { cn } from "@/shared/utils";

interface AgentLog {
  id: string;
  level: "INFO" | "ACTION" | "DECISION" | "ERROR";
  message: string;
  createdAt: string;
}

interface ManagedPair { symbol: string; strategyId: string | null; liveStrategyId: string | null }

interface Agent {
  id: string;
  symbol: string;            // "AUTO" or a fixed pair
  exchange: string;
  mode: "PAPER" | "REAL";
  status: "RUNNING" | "STOPPED" | "ERROR";
  maxPairs: number;
  managed: string;           // JSON ManagedPair[]
  tickIntervalSec: number;
  lastTickAt: string | null;
  lastError: string | null;
  createdAt: string;
  strategy?: { id: string; name: string } | null;
  logs?: AgentLog[];
}

const LEVEL_TONE: Record<string, "default" | "info" | "success" | "danger"> = {
  INFO: "default",
  ACTION: "info",
  DECISION: "success",
  ERROR: "danger",
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("fa-IR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const managedSymbols = (a: Agent): string[] => {
  try {
    const list = JSON.parse(a.managed ?? "[]") as ManagedPair[];
    if (list.length) return list.map((m) => m.symbol);
  } catch { /* fall through */ }
  return a.symbol === "AUTO" ? [] : [a.symbol];
};

export function AgentDialog({ pairs }: { pairs: { symbol: string; exchange: string }[] }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, AgentLog[]>>({});

  const exchanges = useMemo(() => [...new Set(pairs.map((p) => p.exchange))].sort(), [pairs]);
  const [exchange, setExchange] = useState("");
  const [maxPairs, setMaxPairs] = useState("2");
  const [mode, setMode] = useState<"PAPER" | "REAL">("PAPER");
  const [tickMin, setTickMin] = useState("10");

  useEffect(() => { if (!exchange && exchanges.length) setExchange(exchanges[0]); }, [exchanges, exchange]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      const json = await res.json();
      if (res.ok) setAgents(json.agents ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const loadLogs = async (id: string) => {
    const res = await fetch(`/api/agents/${id}/logs`);
    const json = await res.json();
    if (res.ok) setLogs((m) => ({ ...m, [id]: json.logs ?? [] }));
  };

  const toggle = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) loadLogs(next);
  };

  const create = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: exchange || undefined,
          mode,
          maxPairs: Math.max(1, Number(maxPairs) || 1),
          tickIntervalSec: Math.max(1, Number(tickMin) || 10) * 60,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast(json.error ?? "خطا در ساخت ایجنت", "error");
        return;
      }
      toast("ایجنت فعال شد — خودش جفت‌ارزها را انتخاب می‌کند", "success");
      load();
    } finally {
      setCreating(false);
    }
  };

  const stop = async (id: string) => {
    setStopping(id);
    try {
      const res = await fetch(`/api/agents/${id}/stop`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        toast(json.error ?? "خطا", "error");
        return;
      }
      toast("ایجنت متوقف شد", "success");
      load();
    } finally {
      setStopping(null);
    }
  };

  const active = agents.filter((a) => a.status === "RUNNING");
  const stopped = agents.filter((a) => a.status !== "RUNNING");

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="text-xs leading-6 text-muted">
          ایجنت (مدل SWE-2) خودش بهترین جفت‌ارزهای صرافی را اسکن و انتخاب می‌کند، برای هرکدام استراتژی
          مناسب می‌سازد یا از استراتژی‌های موجودت استفاده می‌کند، بک‌تست می‌گیرد و معامله مدیریت می‌کند.
          هدف: حداقل ۵٪ سود در هر ۲۴ ساعت. تو فقط صرافی، تعداد جفت‌ارز و حالت را تعیین می‌کنی.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-5">
          <Field label="صرافی">
            <Select
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              options={exchanges.map((x) => ({ value: x, label: x }))}
            />
          </Field>
          <Field label="تعداد جفت‌ارز">
            <Select
              value={maxPairs}
              onChange={(e) => setMaxPairs(e.target.value)}
              options={[
                { value: "1", label: "۱ جفت" },
                { value: "2", label: "۲ جفت" },
                { value: "3", label: "۳ جفت" },
                { value: "4", label: "۴ جفت" },
                { value: "5", label: "۵ جفت" },
              ]}
            />
          </Field>
          <Field label="حالت">
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as "PAPER" | "REAL")}
              options={[
                { value: "PAPER", label: "تست زنده (بدون پول واقعی)" },
                { value: "REAL", label: "واقعی" },
              ]}
            />
          </Field>
          <Field label="فاصله‌ی بررسی">
            <Select
              value={tickMin}
              onChange={(e) => setTickMin(e.target.value)}
              options={[
                { value: "5", label: "۵ دقیقه" },
                { value: "10", label: "۱۰ دقیقه" },
                { value: "30", label: "۳۰ دقیقه" },
                { value: "60", label: "۱ ساعت" },
              ]}
            />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              onClick={create}
              disabled={creating}
              className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? <Spinner /> : "فعال‌سازی ایجنت"}
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : agents.length === 0 ? (
        <EmptyState title="ایجنتی فعال نیست" hint="بالا صرافی و تعداد جفت‌ارز را انتخاب کن تا ایجنت شروع کند." />
      ) : (
        <div className="space-y-2">
          {active.length > 0 && <p className="text-xs font-bold text-muted">ایجنت‌های فعال ({active.length})</p>}
          {[...active, ...stopped].map((a) => {
            const symbols = managedSymbols(a);
            return (
            <div key={a.id} className="rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button type="button" onClick={() => toggle(a.id)} className="flex flex-1 flex-wrap items-center gap-2 text-start">
                  {a.symbol === "AUTO" ? (
                    <span className="font-mono text-sm font-bold">
                      {symbols.length ? symbols.join(" · ") : `در انتظار انتخاب ${a.maxPairs} جفت‌ارز`}
                    </span>
                  ) : (
                    <span className="font-mono text-sm font-bold">{a.symbol}</span>
                  )}
                  <Badge tone="default">{a.exchange}</Badge>
                  <Badge tone={a.mode === "REAL" ? "warning" : "info"}>{a.mode === "REAL" ? "واقعی" : "تست زنده"}</Badge>
                  <Badge tone={a.status === "RUNNING" ? "success" : "default"}>
                    {a.status === "RUNNING" ? "در حال کار" : a.status === "ERROR" ? "خطا" : "متوقف"}
                  </Badge>
                  <span className="text-[11px] text-muted">
                    هر {Math.round(a.tickIntervalSec / 60)} دقیقه
                    {a.lastTickAt ? ` · آخرین بررسی ${fmtTime(a.lastTickAt)}` : " · در انتظار اولین بررسی"}
                  </span>
                </button>
                {a.status === "RUNNING" && (
                  <button
                    type="button"
                    onClick={() => stop(a.id)}
                    disabled={stopping === a.id}
                    className="rounded-lg bg-danger px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-90 disabled:opacity-50"
                  >
                    {stopping === a.id ? <Spinner /> : "توقف معاملات"}
                  </button>
                )}
                <button type="button" onClick={() => toggle(a.id)} className="text-xs text-primary">
                  {expanded === a.id ? "بستن ▲" : "لاگ ▼"}
                </button>
              </div>
              {a.lastError && (
                <p className="border-t border-border/50 px-3 py-1.5 text-[11px] text-danger">{a.lastError}</p>
              )}
              {expanded === a.id && (
                <div className="max-h-72 space-y-1.5 overflow-y-auto border-t border-border p-3">
                  {(logs[a.id] ?? a.logs ?? []).length === 0 ? (
                    <p className="py-2 text-center text-xs text-muted">هنوز لاگی ثبت نشده — اولین بررسی به‌زودی انجام می‌شود.</p>
                  ) : (
                    (logs[a.id] ?? []).map((l) => (
                      <div key={l.id} className={cn(
                        "rounded-lg border px-3 py-2 text-xs leading-6",
                        l.level === "ERROR" ? "border-danger/30 bg-danger/5" : "border-border/60 bg-surface",
                      )}>
                        <div className="mb-0.5 flex items-center gap-2">
                          <Badge tone={LEVEL_TONE[l.level] ?? "default"}>{l.level}</Badge>
                          <span className="text-[10px] text-muted">{fmtTime(l.createdAt)}</span>
                        </div>
                        <p className="whitespace-pre-wrap">{l.message}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
