"use client";

import { ActionButton } from "@/components/client";

export function SyncButton({ exchange }: { exchange?: string }) {
  return (
    <ActionButton
      endpoint={exchange ? `/api/admin/pairs?exchange=${exchange}` : "/api/admin/pairs"}
      label={exchange ? "همگام‌سازی همین صرافی" : "همگام‌سازی همه صرافی‌ها"}
    />
  );
}

export function TogglePair({ id, active }: { id: string; active: boolean }) {
  return (
    <ActionButton
      endpoint="/api/admin/pairs" method="PATCH"
      payload={{ pairId: id, active: !active }}
      label={active ? "غیرفعال" : "فعال"}
      variant={active ? "danger" : "success"}
    />
  );
}
