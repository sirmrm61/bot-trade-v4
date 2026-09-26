"use client";

import { useState } from "react";
import { ApiForm, Field, Input } from "@/components/client";

export function PlanForm({ plan, compact }: { plan?: {
  id: string; name: string; slug: string; durationDays: number; price: number;
  backtestLimit: number; liveLimit: number; active: boolean; sortOrder: number; description?: string | null;
}; compact?: boolean }) {
  const [open, setOpen] = useState(false);

  if (plan && compact && !open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-bold text-primary">ویرایش</button>
    );
  }

  return (
    <div>
      {plan && <button onClick={() => setOpen(false)} className="mb-2 text-xs text-muted">بستن ×</button>}
      <ApiForm endpoint="/api/admin/plans" submitLabel={plan ? "ذخیره تغییرات" : "ایجاد پلن"} onSuccess={() => setOpen(false)}>
        {plan && <input type="hidden" name="id" value={plan.id} />}
        <Field label="نام"><Input name="name" required defaultValue={plan?.name} /></Field>
        <Field label="شناسه (slug)"><Input name="slug" required defaultValue={plan?.slug} dir="ltr" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="قیمت (تومان)"><Input name="price" type="number" required defaultValue={plan?.price} /></Field>
          <Field label="مدت (روز)"><Input name="durationDays" type="number" required defaultValue={plan?.durationDays} /></Field>
          <Field label="سهمیه بک‌تست"><Input name="backtestLimit" type="number" required defaultValue={plan?.backtestLimit} /></Field>
          <Field label="سهمیه لایو"><Input name="liveLimit" type="number" required defaultValue={plan?.liveLimit} /></Field>
          <Field label="ترتیب"><Input name="sortOrder" type="number" defaultValue={plan?.sortOrder ?? 0} /></Field>
          <Field label="توضیح"><Input name="description" defaultValue={plan?.description ?? ""} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={plan?.active ?? true} className="size-4 accent-primary" />
          فعال
        </label>
      </ApiForm>
    </div>
  );
}
