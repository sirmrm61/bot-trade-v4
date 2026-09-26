"use client";

import { ActionButton } from "@/components/client";

export function ReviewButtons({ id }: { id: string }) {
  return (
    <span className="flex gap-2">
      <ActionButton endpoint="/api/admin/marketplace" payload={{ listingId: id, approve: true }} label="تأیید و انتشار" variant="success" />
      <ActionButton
        endpoint="/api/admin/marketplace"
        payload={() => ({ listingId: id, approve: false, note: window.prompt("دلیل رد:") ?? "" })}
        label="رد" variant="danger"
      />
    </span>
  );
}
