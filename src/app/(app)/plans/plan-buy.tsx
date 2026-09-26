"use client";

import { ActionButton } from "@/components/client";
import { toman } from "@/shared/utils";

export function PlanBuyButton({ planId, price }: { planId: string; price: number }) {
  return (
    <ActionButton
      endpoint="/api/subscriptions/purchase"
      payload={() => ({ planId, idempotencyKey: crypto.randomUUID() })}
      label={`خرید — ${toman(price)}`}
      confirm="هزینه پلن از کیف پول شما کسر می‌شود. ادامه می‌دهید؟"
      className="w-full"
    />
  );
}
