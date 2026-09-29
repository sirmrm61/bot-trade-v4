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
  kind: string;
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

type Mode = "SCALP" | "COMBINED";

const MODES: { key: Mode; title: string; desc: string }[] = [
  {
    key: "SCALP",
    title: "اسکالپ",
    desc: "۵ استراتژی سیگنال (RSI، EMA، MACD، بولینگر) روی بهترین جفت‌های اسکنر با تایم‌فریم ارزیابی‌شده",
  },
  {
    key: "COMBINED",
    title: "ترکیبی",
    desc: "۳ سیگنال + مومنتوم نمادین برای پرنوسان‌ترین جفت + شکست کانال برای کم‌نوسان‌ترین — هر دو با یادگیری خودکار",
  },
];

const KIND_BADGE: Record<string, string> = {
  SIGNAL: "سیگنال",
  ATM_SME: "مومنتوم",
  RMM_BSE: "شکست کانال",
};

/** animated progress block shown while a long-running request is in flight */
function WorkingAnimation({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-5" role="status" aria-live="polite">
      <div className="relative h-10 w-10">
        <div className="absolute inset-0 rounded-full border-4 border-primary/20" />
        <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-primary" />
      </div>
      <p className="text-sm font-bold">{label}</p>
      <p className="text-xs text-muted">این فرایند ممکن است تا یک دقیقه طول بکشد — لطفاً صفحه را نبندید.</p>
    </div>
  );
}

/** "ایجاد خودکار" — scanner picks the best pairs and builds strategies for them. */
export function AutoGenerateButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<Mode | null>(null);
  const [result, setResult] = useState<AutoResult | null>(null);

  async function run(mode: Mode) {
    setRunning(mode);
    setResult(null);
    try {
      const res = await fetch("/api/strategies/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 5, mode }),
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
      setRunning(null);
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
              لغزش، نوسان و هزینه‌ی رفت‌وبرگشت انتخاب می‌کند و برای هرکدام بهترین تایم‌فریم را با داده‌ی
              واقعی کندل‌ها ارزیابی می‌کند. جفت‌هایی که قبلاً استراتژی دارند یا داده‌ی کافی ندارند رد می‌شوند.
            </p>

            {running ? (
              <WorkingAnimation label="در حال اسکن بازار، ارزیابی تایم‌فریم‌ها و ساخت استراتژی‌ها…" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => run(m.key)}
                    className="rounded-xl border border-border p-4 text-start transition hover:border-primary/50 hover:bg-primary/5"
                  >
                    <p className="mb-1 font-bold text-primary">{m.title}</p>
                    <p className="text-xs leading-5 text-muted">{m.desc}</p>
                  </button>
                ))}
              </div>
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
                      {c.kind && KIND_BADGE[c.kind] && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                          {KIND_BADGE[c.kind]}
                        </span>
                      )}
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
