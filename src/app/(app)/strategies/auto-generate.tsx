"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Modal } from "@/components/client";
import { toast } from "@/components/toast";
import { EXCHANGE_LABELS } from "@/shared/constants";

interface CreatedRow {
  id: string;
  name: string;
  symbol: string;
  exchange: string;
  market: string;
  timeframe: string;
  score: number | null;
}
interface SkippedRow { symbol: string; exchange: string; reason: string }
interface AutoResult {
  ok: boolean;
  created: CreatedRow[];
  skipped: SkippedRow[];
  scanned: number;
  ranked: number;
}

/** "ایجاد خودکار" — scanner picks the best pairs and builds strategies for them. */
export function AutoGenerateButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AutoResult | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/strategies/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 5 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "ایجاد خودکار ناموفق بود");
        setOpen(false);
      } else {
        setResult(json as AutoResult);
        router.refresh();
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
      setOpen(false);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setResult(null); setOpen(true); }}
        className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-2 text-sm font-bold text-primary transition hover:bg-primary/10"
      >
        ایجاد خودکار با اسکنر
      </button>
      <Modal
        open={open}
        onClose={() => !running && setOpen(false)}
        title="ایجاد خودکار استراتژی از اسکالپ اسکنر"
      >
        {!result && (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted">
              سیستم بازار را اسکن می‌کند، ۵ جفت‌ارز برتر را بر اساس نقدشوندگی، اسپرد، عمق دفتر سفارش،
              لغزش، نوسان و هزینه‌ی رفت‌وبرگشت انتخاب می‌کند، برای هرکدام بهترین تایم‌فریم را با داده‌ی
              واقعی کندل‌ها ارزیابی می‌کند و یک استراتژی سیگنال با مدیریت ریسک متناسب می‌سازد.
              جفت‌هایی که قبلاً استراتژی دارند یا داده‌ی کافی ندارند رد می‌شوند.
            </p>
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="w-full rounded-xl bg-primary px-4 py-3 font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {running ? "در حال اسکن بازار و ارزیابی جفت‌ها…" : "شروع اسکن و ایجاد ۵ استراتژی"}
            </button>
            {running && (
              <p className="text-xs text-muted">
                این فرایند ممکن است تا یک دقیقه طول بکشد — لطفاً صفحه را نبندید.
              </p>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {result.created.length > 0 ? (
              <div className="rounded-xl border border-success/40 bg-green-50 p-4 dark:bg-green-950/30">
                <p className="mb-2 text-sm font-bold text-success">
                  {result.created.length} استراتژی ساخته شد
                  <span className="ms-2 font-normal text-muted">
                    (از {result.ranked} جفت رتبه‌بندی‌شده بین {result.scanned} جفت اسکن‌شده)
                  </span>
                </p>
                <ul className="space-y-2 text-sm">
                  {result.created.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/strategies/${c.id}`} className="font-bold text-primary hover:underline">
                        {c.name}
                      </Link>
                      <span className="ltr text-xs text-muted">
                        {EXCHANGE_LABELS[c.exchange as keyof typeof EXCHANGE_LABELS] ?? c.exchange}
                        {" · "}{c.timeframe}{c.market === "FUTURES" ? " · پرپچوال ۲×" : " · اسپات"}
                      </span>
                      {c.score !== null && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          امتیاز {c.score.toFixed(0)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted">
                  استراتژی‌ها در حالت پیش‌نویس ساخته شدند — قبل از اجرای زنده بک‌تست بگیرید و پارامترها را بازبینی کنید.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                هیچ استراتژی ساخته نشد — جفت‌ارز مناسبی معیارها را نداشت یا همه از قبل استراتژی داشتند.
              </div>
            )}

            {result.skipped.length > 0 && (
              <details className="rounded-xl border border-border p-3 text-xs text-muted">
                <summary className="cursor-pointer font-bold">
                  {result.skipped.length} جفت رد شد — دلایل
                </summary>
                <ul className="mt-2 space-y-1">
                  {result.skipped.map((s, i) => (
                    <li key={i}>
                      <span className="ltr font-medium">{s.symbol}</span>
                      {" — "}{s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full rounded-xl border border-border px-4 py-2 text-sm font-bold transition hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              بستن
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
