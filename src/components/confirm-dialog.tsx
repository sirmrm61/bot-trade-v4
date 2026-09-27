"use client";

import { useEffect } from "react";
import { cn } from "@/shared/utils";

/** Styled confirmation dialog — replaces window.confirm. */
export function ConfirmDialog({
  open, message, confirmLabel = "تأیید", cancelLabel = "انصراف", danger, onConfirm, onCancel,
}: {
  open: boolean;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        style={{ animation: "dialog-in .18s ease-out" }}
      >
        <div className={cn("h-1", danger ? "bg-danger" : "bg-primary")} />
        <div className="p-5">
          <p className="text-sm font-bold">{danger ? "تأیید عملیات حساس" : "تأیید"}</p>
          <p className="mt-2 text-sm leading-6 text-muted">{message}</p>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={onConfirm}
              className={cn(
                "flex-1 rounded-xl px-4 py-2.5 text-sm font-bold transition hover:opacity-90",
                danger ? "bg-danger text-white" : "bg-primary text-primary-foreground",
              )}
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-bold transition hover:bg-muted"
            >
              {cancelLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
