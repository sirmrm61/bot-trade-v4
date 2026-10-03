"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiForm, Field, Input, ActionButton, Modal, Spinner } from "@/components/client";
import { toast } from "@/components/toast";

/** Connect form for one exchange — includes passphrase field when the exchange needs it. */
export function ConnectForm({ exchange, needsPassphrase }: { exchange: string; needsPassphrase?: boolean }) {
  return (
    <ApiForm endpoint="/api/exchange" submitLabel="اتصال و تست">
      <input type="hidden" name="exchange" value={exchange} />
      <Field label={exchange === "NOBITEX" ? "کلید API (Token)" : "کلید API (API Key)"}>
        <Input name="apiKey" required dir="ltr" placeholder={exchange === "NOBITEX" ? "نوبیتکس API Token" : "KuCoin API Key"} />
      </Field>
      <Field label="کلید محرمانه (Secret)">
        <Input name="apiSecret" type="password" required dir="ltr" />
      </Field>
      {needsPassphrase && (
        <Field label="رمز عبور API (Passphrase)">
          <Input name="apiPassphrase" type="password" required dir="ltr" />
        </Field>
      )}
    </ApiForm>
  );
}

export function TestButton({ exchange }: { exchange: string }) {
  return <ActionButton endpoint="/api/exchange/test" payload={{ exchange }} label="تست اتصال" variant="ghost" />;
}

export function DisconnectButton({ exchange }: { exchange: string }) {
  return (
    <ActionButton
      endpoint="/api/exchange"
      payload={{ exchange, action: "disconnect" }}
      label="قطع اتصال"
      variant="danger"
      confirm="اتصال صرافی قطع شود؟ استراتژی‌های زنده متوقف نمی‌شوند ولی سفارش جدیدی صادر نخواهد شد."
    />
  );
}

const WILL_DELETE = [
  "همه‌ی استراتژی‌های «تست زنده» (Paper) — ابتدا متوقف، بعد حذف می‌شوند",
  "کل تاریخچه‌ی معاملات و سفارش‌های تست زنده",
  "همه‌ی بک‌تست‌ها به‌همراه نتایج و ردیابی (Trace) آن‌ها",
  "سوابق اسکنر فرصت و رویدادهای ردیاب نهنگ",
  "استراتژی‌هایی که به معامله‌ی واقعی یا بازار (Marketplace) گره نخورده‌اند",
];

const WILL_KEEP = [
  "استراتژی‌های زنده‌ی «واقعی» و تمام معاملات/سفارش‌های واقعی — بدون هیچ تغییری",
  "اتصال‌های صرافی، کیف پول، اشتراک و تنظیمات حساب",
  "استراتژی‌هایی که هنوز به معامله‌ی واقعی یا فروش در بازار مرتبط‌اند",
];

/** Danger-zone button — opens an explanatory dialog, then wipes test data. */
export function ResetTestDataButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "خطایی رخ داد");
        return;
      }
      const s = json.summary ?? {};
      toast.success(
        `ریست انجام شد — ${s.deletedBacktests ?? 0} بک‌تست، ${s.deletedTrades ?? 0} معامله‌ی تست و ${s.deletedStrategies ?? 0} استراتژی حذف شد`,
      );
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl bg-danger px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90"
      >
        ریست داده‌های تست
      </button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title="ریست داده‌های تست">
        <div className="space-y-4">
          <p className="text-sm leading-6 text-muted">
            این عملیات <b className="text-danger">غیرقابل‌بازگشت</b> است و تمام داده‌های آزمایشی
            حساب شما را پاک می‌کند. قبل از ادامه، فهرست زیر را با دقت بخوانید:
          </p>

          <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
            <p className="mb-2 text-sm font-bold text-danger">مواردی که حذف می‌شوند:</p>
            <ul className="list-disc space-y-1 pr-5 text-sm leading-6 text-foreground">
              {WILL_DELETE.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>

          <div className="rounded-xl border border-success/30 bg-success/5 p-4">
            <p className="mb-2 text-sm font-bold text-success">مواردی که دست‌نخورده می‌مانند:</p>
            <ul className="list-disc space-y-1 pr-5 text-sm leading-6 text-foreground">
              {WILL_KEEP.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={run}
              disabled={busy}
              className="flex-1 rounded-xl bg-danger px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <span className="inline-flex items-center gap-2"><Spinner />در حال حذف…</span> : "تأیید — همه‌ی داده‌های تست حذف شود"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-bold transition hover:bg-muted disabled:opacity-50"
            >
              انصراف
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
