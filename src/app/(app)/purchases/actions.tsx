"use client";

import { ActionButton } from "@/components/client";

export function SubmitListingButton({ id }: { id: string }) {
  return (
    <ActionButton
      endpoint={`/api/marketplace/${id}/submit`}
      label="ارسال برای بررسی"
      variant="ghost"
      confirm="آگهی برای بررسی مدیر ارسال شود؟"
    />
  );
}
