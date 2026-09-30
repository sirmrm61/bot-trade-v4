"use client";

import { useRouter } from "next/navigation";
import { ActionButton, ApiForm, Field, Input, Select } from "@/components/client";
import { toast } from "@/components/toast";

export function DeleteStrategyButton({
  strategyId,
  redirect,
  compact,
}: {
  strategyId: string;
  redirect?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  return (
    <ActionButton
      endpoint={`/api/strategies/${strategyId}`}
      method="DELETE"
      label="حذف"
      variant="danger"
      confirm="استراتژی و تمام بک‌تست‌ها و نسخه‌های آن حذف می‌شود. این عمل قابل بازگشت نیست — مطمئن هستید؟"
      className={compact ? "!rounded-lg !px-2.5 !py-1 !text-xs" : undefined}
      onDone={() => {
        if (redirect) router.push(redirect);
      }}
    />
  );
}

export function RunBacktestForm({ strategyId, versionId, defaultFrom, defaultTo, onDone }: { strategyId: string; versionId?: string; defaultFrom: string; defaultTo: string; onDone?: () => void }) {
  return (
    <ApiForm
      endpoint="/api/backtests"
      submitLabel="اجرای بک‌تست"
      onSuccess={() => { toast.success("بک‌تست در صف قرار گرفت — نتیجه به‌زودی آماده می‌شود."); onDone?.(); }}
    >
      <input type="hidden" name="strategyId" value={strategyId} />
      {versionId && <input type="hidden" name="versionId" value={versionId} />}
      <Field label="از تاریخ"><Input name="startDate" type="date" required defaultValue={defaultFrom} dir="ltr" /></Field>
      <Field label="تا تاریخ"><Input name="endDate" type="date" required defaultValue={defaultTo} dir="ltr" /></Field>
      <Field label="سرمایه اولیه (تومان)"><Input name="initialBalance" type="number" required defaultValue={10000000} /></Field>
      <Field label="کارمزد ٪"><Input name="feePct" type="number" step="0.01" defaultValue={0.25} /></Field>
      <Field label="لغزش قیمت ٪"><Input name="slippagePct" type="number" step="0.01" defaultValue={0.05} /></Field>
      <Field label="ردیابی (Trace)" hint="خلاصه = معاملات و دلایل رد · کامل = هر مرحله هر کندل">
        <Select name="traceLevel" defaultValue="OFF" options={[
          { value: "OFF", label: "خاموش" },
          { value: "SUMMARY", label: "خلاصه" },
          { value: "FULL", label: "کامل" },
        ]} />
      </Field>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" name="strictCausality" value="true" />
        علیت سخت‌گیرانه — ورود فقط روی کندل بعد از سیگنال (جلوگیری از look-ahead)
      </label>
    </ApiForm>
  );
}

export function GoLiveForm({ strategyId, versionId, hasBacktest, onDone }: { strategyId: string; versionId?: string; hasBacktest: boolean; onDone?: () => void }) {
  // every kind needs a completed backtest before going live with real funds
  // (order-book kinds get a candle-simulated backtest); paper test is exempt
  if (!hasBacktest) {
    return <p className="text-sm text-muted">برای اجرای زنده واقعی، ابتدا یک بک‌تست موفق لازم است.</p>;
  }
  return (
    <ApiForm
      endpoint="/api/live"
      submitLabel="تأیید و شروع"
      onSuccess={() => { toast.success("استراتژی زنده فعال شد."); onDone?.(); }}
    >
      <input type="hidden" name="strategyId" value={strategyId} />
      {versionId && <input type="hidden" name="versionId" value={versionId} />}
      <Field label="سرمایه اختصاصی (تومان)" hint="ربات فقط از این مقدار استفاده می‌کند">
        <Input name="allocatedCapital" type="number" required defaultValue={10000000} />
      </Field>
      <p className="rounded-xl bg-slate-100 p-3 text-xs text-muted dark:bg-slate-800">
        با تأیید، استراتژی در Worker اجرا می‌شود و حد ضرر/سود تنظیم‌شده اعمال خواهد شد.
      </p>
    </ApiForm>
  );
}

/** تست زنده — real-time run against live market data with virtual capital (no real orders). */
export function PaperTestForm({ strategyId, versionId, onDone }: { strategyId: string; versionId?: string; onDone?: () => void }) {
  return (
    <ApiForm
      endpoint="/api/live"
      submitLabel="شروع تست زنده"
      onSuccess={() => { toast.success("تست زنده فعال شد — در صفحه «معاملات زنده» قابل مشاهده است."); onDone?.(); }}
    >
      <input type="hidden" name="strategyId" value={strategyId} />
      {versionId && <input type="hidden" name="versionId" value={versionId} />}
      <input type="hidden" name="mode" value="PAPER" />
      <Field label="سرمایه مجازی (تومان)" hint="بدون نیاز به اتصال صرافی — هیچ سفارش واقعی ثبت نمی‌شود">
        <Input name="allocatedCapital" type="number" required defaultValue={10000000} />
      </Field>
      <p className="rounded-xl bg-slate-100 p-3 text-xs text-muted dark:bg-slate-800">
        استراتژی روی داده‌ی لحظه‌ای بازار اجرا می‌شود و معاملات به‌صورت شبیه‌سازی‌شده ثبت می‌شوند.
      </p>
    </ApiForm>
  );
}

export function SellForm({ strategyId, canSell, existing }: { strategyId: string; canSell: boolean; existing: boolean }) {
  if (existing) return <p className="text-sm text-muted">این استراتژی قبلاً در بازار ثبت شده است.</p>;
  if (!canSell) return <p className="text-sm text-muted">برای فروش، ابتدا یک بک‌تست موفق لازم است.</p>;
  return (
    <ApiForm
      endpoint="/api/marketplace"
      submitLabel="ثبت در بازار"
      onSuccess={() => toast.success("آگهی ثبت شد — برای انتشار از بخش «خریدهای من/آگهی‌ها» ارسال برای بررسی کنید.")}
    >
      <input type="hidden" name="strategyId" value={strategyId} />
      <Field label="عنوان آگهی"><Input name="title" required /></Field>
      <Field label="توضیحات"><Input name="description" /></Field>
      <Field label="قیمت (تومان)"><Input name="price" type="number" required min={0} /></Field>
      <Field label="مدت دسترسی (روز — ۰ یعنی دائمی)"><Input name="subscriptionDays" type="number" defaultValue={0} /></Field>
    </ApiForm>
  );
}
