"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, Input } from "@/components/client";
import { toast } from "@/components/toast";

const PRESETS = [50_000, 100_000, 500_000, 1_000_000];

/** User wallet top-up — simulated gateway (dev). Idempotent per submission. */
export function ChargeForm() {
  const router = useRouter();
  const [amount, setAmount] = useState<number>(100_000);
  const [loading, setLoading] = useState(false);

  async function charge() {
    setLoading(true);
    try {
      const res = await fetch("/api/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, idempotencyKey: `charge-ui:${crypto.randomUUID()}` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(json.error ?? "خطا در شارژ");
      else {
        toast.success("کیف پول با موفقیت شارژ شد.");
        router.refresh();
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="مبلغ شارژ (تومان)" hint="حداقل ۱۰٬۰۰۰ تومان">
        <Input
          type="number"
          min={10_000}
          step={1000}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(p)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition ${
              amount === p ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            {p.toLocaleString("fa-IR")}
          </button>
        ))}
      </div>
      <button
        onClick={charge}
        disabled={loading || amount < 10_000}
        className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "در حال پرداخت…" : "شارژ کیف پول"}
      </button>
      <p className="text-xs text-muted">در نسخه توسعه، شارژ به‌صورت آنی و بدون درگاه واقعی انجام می‌شود.</p>
    </div>
  );
}
