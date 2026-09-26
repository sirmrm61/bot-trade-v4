"use client";

import { ApiForm, Field, Input, ActionButton } from "@/components/client";

export function ConnectForm() {
  return (
    <ApiForm endpoint="/api/exchange" submitLabel="اتصال و تست">
      <Field label="کلید API (Token)">
        <Input name="apiKey" required dir="ltr" placeholder="نوبیتکس API Token" />
      </Field>
      <Field label="کلید محرمانه (Secret)">
        <Input name="apiSecret" type="password" required dir="ltr" />
      </Field>
    </ApiForm>
  );
}

export function TestButton() {
  return <ActionButton endpoint="/api/exchange/test" label="تست اتصال" variant="ghost" />;
}

export function DisconnectButton() {
  return (
    <ActionButton
      endpoint="/api/exchange"
      method="DELETE"
      label="قطع اتصال"
      variant="danger"
      confirm="اتصال صرافی قطع شود؟ استراتژی‌های زنده متوقف نمی‌شوند ولی سفارش جدیدی صادر نخواهد شد."
    />
  );
}
