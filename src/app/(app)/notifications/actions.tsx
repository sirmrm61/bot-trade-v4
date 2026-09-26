"use client";

import { ActionButton } from "@/components/client";

export function MarkAllRead() {
  return <ActionButton endpoint="/api/notifications" payload={{}} label="علامت‌گذاری همه به‌عنوان خوانده‌شده" variant="ghost" />;
}
