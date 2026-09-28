"use client";

import { ApiForm, Field, Input, ActionButton } from "@/components/client";

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
