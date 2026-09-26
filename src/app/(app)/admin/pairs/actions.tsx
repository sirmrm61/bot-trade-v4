"use client";

import { ActionButton } from "@/components/client";

export function SyncButton() {
  return <ActionButton endpoint="/api/admin/pairs" label="همگام‌سازی با نوبیتکس" />;
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
