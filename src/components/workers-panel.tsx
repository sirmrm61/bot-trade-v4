"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils";
import { Badge } from "@/components/ui";
import { ActionButton } from "@/components/client";

/** Live worker control panel — polls status + logs, sends control actions. */

interface QueueStatus {
  name: string;
  label: string;
  paused: boolean;
  counts: Record<string, number>;
}

interface WorkerStatus {
  redis: boolean;
  process: {
    alive: boolean;
    heartbeatAt?: number | null;
    info?: { workerId?: string; pid?: number; startedAt?: string; stoppedAt?: string } | null;
  };
  queues: QueueStatus[];
}

interface LogEntry {
  ts: string;
  level: string;
  proc?: string;
  msg: string;
  module?: string;
  action?: string;
  errorCode?: string;
}

const LEVEL_CLS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-slate-300 dark:text-slate-300",
  debug: "text-slate-500",
};

function relTime(ts?: number | string | null) {
  if (!ts) return "—";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diff < 60) return `${diff} ثانیه پیش`;
  if (diff < 3600) return `${Math.round(diff / 60)} دقیقه پیش`;
  return `${Math.round(diff / 3600)} ساعت پیش`;
}

export function WorkersPanel() {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState("all");
  const [procFilter, setProcFilter] = useState("all");
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const [s, l] = await Promise.all([
      fetch("/api/admin/workers").then((r) => r.json()).catch(() => null),
      fetch("/api/admin/workers/logs?n=400").then((r) => r.json()).catch(() => null),
    ]);
    if (s) setStatus(s);
    if (l?.logs) setLogs(l.logs);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => void refresh(), 5000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [refresh]);

  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, follow]);

  const filtered = logs.filter(
    (l) =>
      (levelFilter === "all" || l.level === levelFilter) &&
      (procFilter === "all" || l.proc === procFilter),
  );

  return (
    <div className="space-y-6">
      {/* process status + controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4">
        <div className="flex items-center gap-3">
          <Badge tone={status?.process.alive ? "success" : "danger"}>
            {status ? (status.process.alive ? "ورکر فعال" : "ورکر متوقف") : "در حال بررسی…"}
          </Badge>
          {status && !status.redis && <Badge tone="danger">Redis در دسترس نیست</Badge>}
          <div className="text-xs text-muted">
            {status?.process.info?.workerId && (
              <span className="ltr mr-2">{status.process.info.workerId}</span>
            )}
            {status?.process.alive
              ? `آخرین ضربان: ${relTime(status.process.heartbeatAt)}`
              : status?.process.info?.stoppedAt
                ? `توقف: ${relTime(status.process.info.stoppedAt)}`
                : status?.process.info?.startedAt
                  ? `آخرین اجرا: ${relTime(status.process.info.startedAt)}`
                  : "هیچ اجرایی ثبت نشده"}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            endpoint="/api/admin/workers"
            payload={{ action: "start" }}
            label="اجرای ورکر"
            variant="success"
            onDone={refresh}
          />
          <ActionButton
            endpoint="/api/admin/workers"
            payload={{ action: "pause-all" }}
            label="توقف موقت همه صف‌ها"
            variant="ghost"
            onDone={refresh}
          />
          <ActionButton
            endpoint="/api/admin/workers"
            payload={{ action: "shutdown" }}
            label="توقف کامل ورکر"
            variant="danger"
            confirm="پروسه‌ی ورکر کاملاً متوقف می‌شود. برای راه‌اندازی مجدد باید «اجرای ورکر» را بزنید. ادامه می‌دهید؟"
            onDone={refresh}
          />
        </div>
      </div>

      {/* per-queue status */}
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-slate-50 text-right text-xs text-muted dark:bg-slate-800/50">
              <th className="px-4 py-3">صف / ورکر</th>
              <th className="px-4 py-3">وضعیت</th>
              <th className="px-4 py-3">در انتظار</th>
              <th className="px-4 py-3">در حال اجرا</th>
              <th className="px-4 py-3">موفق</th>
              <th className="px-4 py-3">ناموفق</th>
              <th className="px-4 py-3">عملیات</th>
            </tr>
          </thead>
          <tbody>
            {(status?.queues ?? []).map((q) => (
              <tr key={q.name} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-bold">{q.label}</div>
                  <div className="ltr text-xs text-muted">{q.name}</div>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={q.paused ? "warning" : "success"}>{q.paused ? "متوقف موقت" : "فعال"}</Badge>
                </td>
                <td className="px-4 py-3 ltr">{q.counts.waiting ?? 0}</td>
                <td className="px-4 py-3 ltr">{q.counts.active ?? 0}</td>
                <td className="px-4 py-3 ltr">{q.counts.completed ?? 0}</td>
                <td className={cn("px-4 py-3 ltr", (q.counts.failed ?? 0) > 0 && "font-bold text-danger")}>
                  {q.counts.failed ?? 0}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {q.paused ? (
                      <ActionButton
                        endpoint="/api/admin/workers"
                        payload={{ action: "resume", queue: q.name }}
                        label="ادامه"
                        variant="success"
                        className="px-2.5 py-1 text-xs"
                        onDone={refresh}
                      />
                    ) : (
                      <ActionButton
                        endpoint="/api/admin/workers"
                        payload={{ action: "pause", queue: q.name }}
                        label="توقف موقت"
                        variant="ghost"
                        className="px-2.5 py-1 text-xs"
                        onDone={refresh}
                      />
                    )}
                    <ActionButton
                      endpoint="/api/admin/workers"
                      payload={{ action: "drain", queue: q.name }}
                      label="خالی‌کردن صف"
                      variant="danger"
                      className="px-2.5 py-1 text-xs"
                      confirm={`تمام ${q.counts.waiting ?? 0} کار در انتظار «${q.label}» حذف می‌شود. ادامه می‌دهید؟`}
                      onDone={refresh}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* log viewer */}
      <div className="rounded-2xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <span className="text-sm font-bold">لاگ سیستم (اپ + ورکر)</span>
          <div className="flex items-center gap-2 text-xs">
            <select
              value={procFilter}
              onChange={(e) => setProcFilter(e.target.value)}
              className="rounded-lg border border-border bg-card px-2 py-1"
            >
              <option value="all">همه پروسه‌ها</option>
              <option value="worker">فقط ورکر</option>
              <option value="app">فقط اپ</option>
            </select>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="rounded-lg border border-border bg-card px-2 py-1"
            >
              <option value="all">همه سطح‌ها</option>
              <option value="error">خطا</option>
              <option value="warn">هشدار</option>
              <option value="info">اطلاع</option>
              <option value="debug">دیباگ</option>
            </select>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              دنبال‌کردن
            </label>
          </div>
        </div>
        <div ref={logRef} className="max-h-96 overflow-y-auto bg-slate-950 p-3 font-mono text-xs leading-6" dir="ltr">
          {filtered.length === 0 && (
            <div className="text-slate-500">لاگی برای نمایش نیست — گزارش‌ها پس از بارگذاری ماژول Redis در «system:logs» ذخیره می‌شوند.</div>
          )}
          {filtered.map((l, i) => (
            <div key={i} className="flex gap-2 whitespace-nowrap">
              <span className="text-slate-600">{new Date(l.ts).toLocaleTimeString("en-GB")}</span>
              <span className={cn("w-12 shrink-0 uppercase", LEVEL_CLS[l.level] ?? "text-slate-400")}>
                {l.level}
              </span>
              <span className="w-14 shrink-0 text-slate-600">[{l.proc ?? "app"}]</span>
              <span className="text-slate-200">
                {l.msg}
                {l.module ? <span className="text-slate-500"> — {l.module}{l.action ? ` · ${l.action}` : ""}</span> : l.action ? <span className="text-slate-500"> — {l.action}</span> : null}
                {l.errorCode ? <span className="text-red-400"> — {l.errorCode}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
