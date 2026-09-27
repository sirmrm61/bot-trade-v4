"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { cn } from "@/shared/utils";

/** Generic API mutation button with loading + Persian error handling. */
export function ActionButton({
  endpoint, method = "POST", payload, label, confirm, className, variant = "primary", onDone,
}: {
  endpoint: string;
  method?: string;
  payload?: Record<string, unknown> | (() => Record<string, unknown>);
  label: string;
  confirm?: string;
  className?: string;
  variant?: "primary" | "danger" | "ghost" | "success";
  onDone?: (res: unknown) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variants = {
    primary: "bg-primary text-primary-foreground hover:opacity-90",
    danger: "bg-danger text-white hover:opacity-90",
    success: "bg-success text-white hover:opacity-90",
    ghost: "border border-border hover:bg-slate-100 dark:hover:bg-slate-800",
  };

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: payload ? JSON.stringify(typeof payload === "function" ? payload() : payload) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? "خطایی رخ داد");
      else {
        onDone?.(json);
        router.refresh();
      }
    } catch {
      setError("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        onClick={run}
        disabled={loading}
        className={cn(
          "rounded-xl px-4 py-2 text-sm font-bold transition disabled:opacity-50",
          variants[variant],
          className,
        )}
      >
        {loading ? "در حال پردازش…" : label}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

/** Generic JSON form → POST to endpoint, shows field errors in Persian. */
export function ApiForm({
  endpoint, method = "POST", children, submitLabel = "ثبت", onSuccess, className,
}: {
  endpoint: string;
  method?: string;
  children: ReactNode;
  submitLabel?: string;
  className?: string;
  onSuccess?: (json: unknown) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {};
    for (const el of Array.from(e.currentTarget.elements)) {
      const input = el as HTMLInputElement;
      if (!input.name || input.disabled) continue;
      const v = fd.get(input.name);
      if (input.type === "checkbox") payload[input.name] = input.checked;
      else if (input.type === "number") payload[input.name] = v === "" || v === null ? undefined : Number(v);
      else payload[input.name] = v === "" || v === null ? undefined : v;
    }
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? "خطایی رخ داد");
      else {
        onSuccess?.(json);
        router.refresh();
      }
    } catch {
      setError("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)}>
      {children}
      {error && (
        <div className="rounded-xl border border-danger/30 bg-red-50 px-4 py-3 text-sm text-danger dark:bg-red-950/30">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "در حال پردازش…" : submitLabel}
      </button>
    </form>
  );
}

let helpTipSeq = 0;
export const HELP_TIP_EVENT = "bottrade:helptip";

/** Clickable "؟" icon — opens a styled popover guiding the user. Only one stays open at a time. */
export function HelpTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const idRef = useRef(++helpTipSeq);
  const rootRef = useRef<HTMLSpanElement>(null);

  // close when another HelpTip opens — a single popover stays open at a time
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== idRef.current) setOpen(false);
    };
    window.addEventListener(HELP_TIP_EVENT, onOther);
    return () => window.removeEventListener(HELP_TIP_EVENT, onOther);
  }, []);

  // click-outside + Escape close — listeners only attached while open
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="راهنمای تنظیم"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => {
            if (!v) window.dispatchEvent(new CustomEvent<number>(HELP_TIP_EVENT, { detail: idRef.current }));
            return !v;
          });
        }}
        className={cn(
          "inline-flex size-[18px] items-center justify-center rounded-full border text-[11px] font-bold leading-none transition-all",
          open
            ? "scale-110 border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/40"
            : "border-primary/50 text-primary hover:border-primary hover:bg-primary/10",
        )}
      >
        ؟
      </button>
      {open && (
        <span
          className="absolute start-0 top-full z-30 mt-2 block w-72 max-w-[80vw] origin-top"
          style={{ animation: "helptip-in .15s ease-out" }}
        >
          <span className="absolute -top-[5px] start-2.5 size-2.5 rotate-45 border-s border-t border-primary/25 bg-card" />
          <span className="relative block overflow-hidden rounded-2xl border border-primary/25 bg-card/95 shadow-xl shadow-primary/10 backdrop-blur-md">
            <span className="flex items-center gap-1.5 border-b border-border/60 bg-primary/5 px-3 py-1.5 text-[10px] font-bold text-primary">
              <span className="size-1.5 rounded-full bg-primary" />
              راهنما
            </span>
            <span className="block px-3 py-2.5 text-start text-xs font-normal leading-6 text-foreground/90">
              {text}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

export function Field({ label, children, hint, help }: { label: string; children: ReactNode; hint?: string; help?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        {label}
        {help && <HelpTip text={help} />}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputCls, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { options?: { value: string; label: string }[] }) {
  const { options, children, ...rest } = props;
  return (
    <select {...rest} className={cn(inputCls, props.className)}>
      {options ? options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>) : children}
    </select>
  );
}
