"use client";

import { ApiForm, Field, Input, Select } from "@/components/client";

export function ChargeForm({ users }: { users: { id: string; username: string }[] }) {
  return (
    <ApiForm endpoint="/api/admin/wallets" submitLabel="شارژ حساب">
      <Field label="کاربر">
        <Select name="userId" required options={users.map((u) => ({ value: u.id, label: u.username }))} />
      </Field>
      <Field label="مبلغ (تومان)"><Input name="amount" type="number" required min={1} /></Field>
      <Field label="توضیح"><Input name="description" required /></Field>
      <Field label="نام بانک"><Input name="bankName" /></Field>
      <Field label="ساعت واریز"><Input name="depositTime" placeholder="۱۴:۳۰" /></Field>
    </ApiForm>
  );
}
