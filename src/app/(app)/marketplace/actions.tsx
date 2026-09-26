"use client";

import { ActionButton } from "@/components/client";

export function BuyButton({ listingId }: { listingId: string }) {
  return (
    <ActionButton
      endpoint={`/api/marketplace/${listingId}/purchase`}
      payload={() => ({ idempotencyKey: crypto.randomUUID() })}
      label="خرید استراتژی"
      confirm="مبلغ از کیف پول شما کسر و نسخه‌ای از استراتژی برای شما ساخته می‌شود. ادامه می‌دهید؟"
      className="w-full"
    />
  );
}
