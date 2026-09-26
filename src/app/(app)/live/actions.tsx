"use client";

import { ActionButton } from "@/components/client";

export function PauseButton({ id }: { id: string }) {
  return (
    <ActionButton
      endpoint={`/api/live/${id}/pause`}
      label="توقف موقت"
      variant="ghost"
      confirm="استراتژی متوقف موقت شود؟ معاملات باز همچنان مدیریت می‌شوند."
    />
  );
}

export function StopButtons({ id }: { id: string }) {
  return (
    <span className="flex gap-2">
      <ActionButton
        endpoint={`/api/live/${id}/stop`}
        payload={{ stopPolicy: "KEEP_MANAGING" }}
        label="توقف (مدیریت معاملات باز)"
        variant="ghost"
        confirm="استراتژی متوقف شود ولی معاملات باز همچنان مدیریت شوند؟"
      />
      <ActionButton
        endpoint={`/api/live/${id}/stop`}
        payload={{ stopPolicy: "CLOSE_ALL" }}
        label="توقف و بستن معاملات"
        variant="danger"
        confirm="استراتژی متوقف و تمام معاملات باز با قیمت بازار بسته شوند؟"
      />
    </span>
  );
}
