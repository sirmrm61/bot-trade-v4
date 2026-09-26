import { cn } from "@/shared/utils";
import type { ReactNode } from "react";

/** Shared UI primitives — RTL-first, token-driven, light/dark. */

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-card p-5 shadow-sm", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-base font-bold text-card-foreground mb-3", className)}>{children}</h3>;
}

export function StatCard({ label, value, hint, tone }: {
  label: string; value: ReactNode; hint?: string;
  tone?: "default" | "success" | "danger" | "warning";
}) {
  const toneCls = {
    default: "text-card-foreground",
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
  }[tone ?? "default"];
  return (
    <Card>
      <div className="text-sm text-muted">{label}</div>
      <div className={cn("mt-1 text-2xl font-black", toneCls)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

const BADGE_TONES: Record<string, string> = {
  default: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  danger: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  info: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
};

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: keyof typeof BADGE_TONES }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", BADGE_TONES[tone])}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: keyof typeof BADGE_TONES }> = {
    DRAFT: { label: "پیش‌نویس", tone: "default" },
    BACKTESTING: { label: "در حال بک‌تست", tone: "info" },
    READY: { label: "آماده", tone: "success" },
    LIVE: { label: "زنده", tone: "success" },
    PAUSED: { label: "متوقف موقت", tone: "warning" },
    STOPPING: { label: "در حال توقف", tone: "warning" },
    STOPPED: { label: "متوقف", tone: "default" },
    ERROR: { label: "خطا", tone: "danger" },
    EXPIRED: { label: "منقضی", tone: "danger" },
    STARTING: { label: "در حال شروع", tone: "info" },
    RUNNING: { label: "در حال اجرا", tone: "success" },
    DEGRADED: { label: "کاهش‌یافته", tone: "warning" },
    QUEUED: { label: "در صف", tone: "info" },
    COMPLETED: { label: "تکمیل‌شده", tone: "success" },
    FAILED: { label: "ناموفق", tone: "danger" },
    PENDING: { label: "در انتظار", tone: "info" },
    SUBMITTED: { label: "ثبت‌شده", tone: "info" },
    PARTIALLY_FILLED: { label: "پرشده جزئی", tone: "warning" },
    FILLED: { label: "پرشده", tone: "success" },
    CANCELLED: { label: "لغوشده", tone: "default" },
    REJECTED: { label: "ردشده", tone: "danger" },
    OPEN: { label: "باز", tone: "info" },
    CLOSING: { label: "در حال بستن", tone: "warning" },
    CLOSED: { label: "بسته", tone: "default" },
    TRIAL: { label: "آزمایشی", tone: "info" },
    ACTIVE: { label: "فعال", tone: "success" },
    EXPIRING: { label: "رو به اتمام", tone: "warning" },
    GRACE_PERIOD: { label: "مهلت ارفاق", tone: "warning" },
    RESTRICTED: { label: "محدود", tone: "danger" },
    SUSPENDED: { label: "معلق", tone: "danger" },
    PENDING_REVIEW: { label: "در انتظار بررسی", tone: "info" },
    APPROVED: { label: "تأییدشده", tone: "success" },
    PUBLISHED: { label: "منتشرشده", tone: "success" },
    CONNECTED: { label: "متصل", tone: "success" },
    DISCONNECTED: { label: "قطع", tone: "default" },
  };
  const s = map[status] ?? { label: status, tone: "default" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-slate-50 dark:bg-slate-800/50">
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 text-right font-medium text-muted whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16 text-center">
      <div className="text-4xl mb-3">📭</div>
      <div className="font-bold">{title}</div>
      {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-black">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
