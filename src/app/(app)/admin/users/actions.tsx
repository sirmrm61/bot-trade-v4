"use client";

import { ActionButton } from "@/components/client";

export function UserActions({ userId, status }: { userId: string; status: string }) {
  return (
    <span className="flex gap-1">
      {status !== "SUSPENDED" ? (
        <ActionButton endpoint="/api/admin/users" method="PATCH" payload={{ userId, status: "SUSPENDED" }} label="تعلیق" variant="danger" confirm="کاربر تعلیق شود؟" />
      ) : (
        <ActionButton endpoint="/api/admin/users" method="PATCH" payload={{ userId, status: "ACTIVE" }} label="فعال‌سازی" variant="success" />
      )}
    </span>
  );
}
