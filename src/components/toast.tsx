"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/shared/utils";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  leaving?: boolean;
}

const TOAST_EVENT = "bottrade:toast";
const DURATION = 4500;
let seq = 0;

/** Fire a toast from anywhere — no hook needed. */
export function toast(text: string, tone: ToastTone = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ text: string; tone: ToastTone }>(TOAST_EVENT, { detail: { text, tone } }));
}

toast.success = (t: string) => toast(t, "success");
toast.error = (t: string) => toast(t, "error");
toast.info = (t: string) => toast(t, "info");

const ToastCtx = createContext<typeof toast>(toast);

/** Hook form — same as the global `toast()` but reads nicer inside components. */
export function useToast() {
  return useContext(ToastCtx);
}

const TONE_CLS: Record<ToastTone, string> = {
  success: "border-success/40 text-success",
  error: "border-danger/40 text-danger",
  info: "border-primary/40 text-primary",
};
const TONE_DOT: Record<ToastTone, string> = {
  success: "bg-success",
  error: "bg-danger",
  info: "bg-primary",
};

/** Fixed toast stack — listens for the global event; mount once in AppShell. */
export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>[]>>(new Map());

  const dismiss = useCallback((id: number) => {
    setItems((s) => s.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const t = setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 180);
    timers.current.get(id)?.push(t);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; tone: ToastTone }>).detail;
      const id = ++seq;
      setItems((s) => [...s.slice(-4), { id, text: d.text, tone: d.tone }]);
      const t = setTimeout(() => dismiss(id), DURATION);
      pending.set(id, [t]);
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => {
      window.removeEventListener(TOAST_EVENT, on);
      for (const ts of pending.values()) ts.forEach(clearTimeout);
    };
  }, [dismiss]);

  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 start-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          style={{ animation: t.leaving ? "toast-out .18s ease-in forwards" : "toast-in .25s ease-out" }}
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-2xl border bg-card/95 px-4 py-3 text-start text-xs font-medium leading-5 shadow-xl backdrop-blur-md",
            TONE_CLS[t.tone],
          )}
        >
          <span className={cn("mt-1 size-2 shrink-0 rounded-full", TONE_DOT[t.tone])} />
          <span className="flex-1 text-foreground/90">{t.text}</span>
        </button>
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <ToastHost />
    </ToastCtx.Provider>
  );
}
