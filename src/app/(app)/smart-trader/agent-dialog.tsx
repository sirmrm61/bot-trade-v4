"use client";

import { useCallback, useEffect, useState } from "react";
import { Spinner, Field, Select, SearchableSelect } from "@/components/client";
import { Badge, EmptyState } from "@/components/ui";
import { toast } from "@/components/toast";
import { cn } from "@/shared/utils";

interface AgentLog {
  id: string;
  level: "INFO" | "ACTION" | "DECISION" | "ERROR";
  message: string;
  createdAt: string;
}

interface Agent {
  id: string;
  symbol: string;
  exchange: string;
  mode: "PAPER" | "REAL";
  status: "RUNNING" | "STOPPED" | "ERROR";
  strategyId: string | null;
  liveStrategyId: string | null;
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

export function AgentDialog({ pairs }: { pairs: { symbol: string; exchange: string }[] }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, AgentLog[]>>({});

  const [symbol, setSymbol] = useState("");
  const [mode, setMode] = useState<"PAPER" | "REAL">("PAPER");
  const [tickMin, setTickMin] = useState("10");

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
    if (!symbol) return;
    setCreating(true);
    try {
      const pair = pairs.find((p) => p.symbol === symbol);
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          exchange: pair?.exchange,
          mode,
          tickIntervalSec: Math.max(1, Number(tickMin) || 10) * 60,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast(json.error ?? "خطا در ساخت ایجنت", "error");
        return;
      }
      toast(`ایجنت ${symbol} فعال شد`, "success");
      setSymbol("");
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
          برای هر جفت‌ارز یک ایجنت مستقل (با مدل SWE-2) باز می‌شود که دوره‌ای بازار را بررسی می‌کند،
          استراتژی می‌سازد یا اصلاح می‌کند، معامله باز/بسته می‌کند و گزارشش را همین‌جا می‌نویسد.
          هر ایجنت سشن و حافظه‌ی خودش را دارد.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="جفت‌ارز">
            <SearchableSelect
              value={symbol}
              onValueChange={setSymbol}
              placeholder="انتخاب…"
              options={pairs.map((p) => ({ value: p.symbol, label: p.symbol }))}
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
          <Field label="فاصله‌ی بررسی (دقیقه)">
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
              disabled={creating || !symbol}
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
        <EmptyState title="ایجنتی فعال نیست" hint="بالا یک جفت‌ارز انتخاب کن تا اولین ایجنت ساخته شود." />
      ) : (
        <div className="space-y-2">
          {active.length > 0 && <p className="text-xs font-bold text-muted">ایجنت‌های فعال ({active.length})</p>}
          {[...active, ...stopped].map((a) => (
            <div key={a.id} className="rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button type="button" onClick={() => toggle(a.id)} className="flex flex-1 flex-wrap items-center gap-2 text-start">
                  <span className="font-mono text-sm font-bold">{a.symbol}</span>
                  <Badge tone={a.mode === "REAL" ? "warning" : "info"}>{a.mode === "REAL" ? "واقعی" : "تست زنده"}</Badge>
                  <Badge tone={a.status === "RUNNING" ? "success" : "default"}>
                    {a.status === "RUNNING" ? "در حال کار" : a.status === "ERROR" ? "خطا" : "متوقف"}
                  </Badge>
                  {a.strategy && <Badge tone="default">{a.strategy.name}</Badge>}
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
          ))}
        </div>
      )}
    </div>
  );
}
