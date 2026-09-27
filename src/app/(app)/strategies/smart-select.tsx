"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Field, Input, Select } from "@/components/client";
import { toast } from "@/components/toast";
import { TIMEFRAMES } from "@/shared/constants";

interface LeaderboardRow {
  label: string;
  signals: number;
  buys: number;
  sells: number;
  trades?: number;
  profitPct?: number;
  winRate?: number;
}

interface SmartResult {
  ok: boolean;
  created: boolean;
  strategy: { id: string; name: string } | null;
  backtestId: string | null;
  winner: { label: string; signals: number; profitPct: number; trades: number } | null;
  candidatesTested: number;
  leaderboard: LeaderboardRow[];
}

export function SmartSelectForm({ pairs }: { pairs: { symbol: string }[] }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SmartResult | null>(null);

  const [defaults] = useState(() => {
    const now = Date.now();
    return {
      from: new Date(now - 14 * 86_400_000).toISOString().slice(0, 10),
      to: new Date(now).toISOString().slice(0, 10),
    };
  });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      symbol: String(fd.get("symbol") ?? ""),
      timeframe: String(fd.get("timeframe") ?? ""),
      startDate: String(fd.get("startDate") ?? ""),
      endDate: String(fd.get("endDate") ?? ""),
      initialBalance: Number(fd.get("initialBalance") ?? 0),
      feePct: fd.get("feePct") ? Number(fd.get("feePct")) : undefined,
      slippagePct: fd.get("slippagePct") ? Number(fd.get("slippagePct")) : undefined,
    };
    try {
      const res = await fetch("/api/strategies/smart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(json.error ?? "خطایی رخ داد");
      else setResult(json as SmartResult);
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="نماد">
          <Select name="symbol" required options={pairs.map((p) => ({ value: p.symbol, label: p.symbol }))} dir="ltr" />
        </Field>
        <Field label="تایم‌فریم">
          <Select name="timeframe" required options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} dir="ltr" />
        </Field>
        <Field label="از تاریخ"><Input name="startDate" type="date" required defaultValue={defaults.from} dir="ltr" /></Field>
        <Field label="تا تاریخ"><Input name="endDate" type="date" required defaultValue={defaults.to} dir="ltr" /></Field>
        <Field label="سرمایه اولیه (تومان)"><Input name="initialBalance" type="number" required defaultValue={10000000} /></Field>
        <Field label="کارمزد ٪"><Input name="feePct" type="number" step="0.01" defaultValue={0.25} /></Field>
        <Field label="لغزش قیمت ٪"><Input name="slippagePct" type="number" step="0.01" defaultValue={0.05} /></Field>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "در حال تست ترکیب‌ها…" : "اجرای انتخاب هوشمند"}
          </button>
        </div>
      </form>

      {loading && (
        <p className="mt-4 text-xs text-muted">
          سیستم در حال ارزیابی همه‌ی ترکیب‌های اندیکاتورها روی داده تاریخی است — ممکن است چند لحظه طول بکشد.
        </p>
      )}

      {result && (
        <div className="mt-6 space-y-4">
          {result.created && result.winner && result.strategy ? (
            <div className="rounded-xl border border-success/40 bg-green-50 px-4 py-3 text-sm dark:bg-green-950/30">
              <span className="font-bold text-success">برنده: {result.winner.label}</span>
              <span className="mx-2 text-muted">·</span>
              {result.winner.signals} سیگنال · {result.winner.trades} معامله ·{" "}
              <span className={result.winner.profitPct >= 0 ? "text-success" : "text-danger"}>
                {result.winner.profitPct.toFixed(2)}٪
              </span>
              <div className="mt-2 flex gap-4">
                <button
                  type="button"
                  onClick={() => router.push(`/strategies/${result.strategy!.id}`)}
                  className="font-bold text-primary"
                >
                  مشاهده استراتژی «{result.strategy.name}» ←
                </button>
                <button
                  type="button"
                  onClick={() => router.push(`/backtests/${result.backtestId}`)}
                  className="font-bold text-primary"
                >
                  نمودار بک‌تست ←
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
              هیچ ترکیب سوددهی در این بازه یافت نشد — استراتژی ساخته نشد. بازه یا نماد دیگری را امتحان کنید.
            </div>
          )}

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted">
                <th className="py-2 text-right font-medium">ترکیب</th>
                <th className="py-2 text-right font-medium">سیگنال‌ها</th>
                <th className="py-2 text-right font-medium">خرید/فروش</th>
                <th className="py-2 text-right font-medium">معاملات</th>
                <th className="py-2 text-right font-medium">سود</th>
                <th className="py-2 text-right font-medium">نرخ برد</th>
              </tr>
            </thead>
            <tbody>
              {result.leaderboard.map((r, i) => (
                <tr key={i} className={`border-b border-border/50 ${i === 0 ? "bg-primary/5 font-bold" : ""}`}>
                  <td className="py-2 ltr">{r.label}</td>
                  <td className="py-2">{r.signals}</td>
                  <td className="py-2 text-muted">{r.buys} / {r.sells}</td>
                  <td className="py-2">{r.trades ?? "—"}</td>
                  <td className="py-2">
                    {r.profitPct === undefined ? "—" : (
                      <span className={r.profitPct >= 0 ? "text-success" : "text-danger"}>{r.profitPct.toFixed(2)}٪</span>
                    )}
                  </td>
                  <td className="py-2">{r.winRate === undefined ? "—" : `${r.winRate.toFixed(0)}٪`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted">{result.candidatesTested} ترکیب بررسی شد؛ برای برترین‌ها بک‌تست کامل اجرا شد.</p>
        </div>
      )}
    </div>
  );
}
