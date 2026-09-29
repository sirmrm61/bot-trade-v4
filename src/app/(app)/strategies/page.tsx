import Link from "next/link";
import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, PageHeader, StatusBadge, Table, EmptyState, Badge } from "@/components/ui";
import { STRATEGY_KIND_LABELS, type StrategyKind } from "@/shared/constants";
import { faPercent } from "@/shared/utils";
import { cn } from "@/shared/utils";
import { DeleteStrategyButton } from "./[id]/actions";
import { AutoGenerateButton } from "./auto-generate";
import { StrategyRowActions } from "./row-actions";

const TABS = [
  { key: "all", label: "همه" },
  { key: "live", label: "لایو" },
  { key: "draft", label: "پیش‌نویس" },
] as const;

const ACTIVE_LIVE = ["RUNNING", "PAUSED", "STARTING"] as const;

export default async function StrategiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await currentSession();
  const { view = "all" } = await searchParams;

  const strategies = await prisma.strategy.findMany({
    where: { userId: session!.sub, status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1 },
      backtests: { where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, take: 1 },
      liveStrategies: { select: { mode: true, status: true } },
      _count: { select: { backtests: true } },
    },
  });

  const hasActiveLive = (s: (typeof strategies)[number]) =>
    s.liveStrategies.some((l) => (ACTIVE_LIVE as readonly string[]).includes(l.status));

  const filtered = strategies.filter((s) =>
    view === "live" ? hasActiveLive(s)
      : view === "draft" ? s.status === "DRAFT"
      : true,
  );
  const counts = {
    all: strategies.length,
    live: strategies.filter(hasActiveLive).length,
    draft: strategies.filter((s) => s.status === "DRAFT").length,
  };

  return (
    <div>
      <PageHeader
        title="استراتژی‌ها"
        description="استراتژی بسازید، ویرایش کنید و نسخه‌های مختلف را مدیریت کنید"
        action={
          <div className="flex items-center gap-2">
            <AutoGenerateButton />
            <Link href="/strategies/create" className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">
              + استراتژی جدید
            </Link>
          </div>
        }
      />
      {strategies.length === 0 ? (
        <EmptyState title="هنوز استراتژی ندارید" hint="اولین استراتژی خود را بسازید یا با «ایجاد خودکار با اسکنر» به سیستم بسپارید" />
      ) : (
        <>
          <div className="mb-4 flex gap-1 border-b border-border">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={`/strategies?view=${t.key}`}
                className={cn(
                  "-mb-px border-b-2 px-4 py-2 text-sm font-bold transition",
                  view === t.key
                    ? "border-primary text-primary"
                    : "border-transparent text-muted hover:text-foreground",
                )}
              >
                {t.label}
                <span className="ms-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                  {counts[t.key]}
                </span>
              </Link>
            ))}
          </div>
          {filtered.length === 0 ? (
            <EmptyState title="موردی در این دسته نیست" hint="فیلتر دیگری را انتخاب کنید" />
          ) : (
          <Card>
            <Table headers={["نام", "نسخه", "نماد/تایم‌فریم", "آخرین بک‌تست", "فعالیت", "وضعیت", "عملیات"]}>
              {filtered.map((s) => {
                const v = s.versions[0];
                const bt = s.backtests[0];
                const paperCount = s.liveStrategies.filter((l) => l.mode === "PAPER").length;
                const realCount = s.liveStrategies.filter((l) => l.mode !== "PAPER").length;
                return (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <div className="font-bold">{s.name}</div>
                      {s.origin !== "USER" && <Badge tone="info">{s.origin === "PURCHASED" ? "خریداری‌شده" : s.origin === "AI" ? "هوش مصنوعی" : "کپی"}</Badge>}
                      {v?.kind && v.kind !== "SIGNAL" && <Badge tone="info">{STRATEGY_KIND_LABELS[v.kind as StrategyKind]}</Badge>}
                    </td>
                    <td className="px-4 py-3 text-muted">v{v?.versionNumber ?? 0}</td>
                    <td className="px-4 py-3 ltr text-sm">{v ? `${v.symbol} · ${v.timeframe}` : "—"}</td>
                    <td className="px-4 py-3">
                      {bt ? (
                        <span className={bt.profitPct! >= 0 ? "text-success" : "text-danger"}>
                          {faPercent(bt.profitPct)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
                        <span title="تعداد بک‌تست‌ها" className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                          بک‌تست {s._count.backtests}
                        </span>
                        <span title="تعداد تست‌های معاملات زنده (مجازی)" className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                          تست {paperCount}
                        </span>
                        <span title="تعداد معاملات زنده‌ی واقعی" className={cn(
                          "rounded-full px-2 py-0.5",
                          realCount > 0 ? "bg-success/10 font-bold text-success" : "bg-slate-100 dark:bg-slate-800",
                        )}>
                          لایو {realCount}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StrategyRowActions
                          strategyId={s.id}
                          versionId={v?.id}
                          strategyName={s.name}
                          hasBacktest={!!bt}
                        />
                        <Link href={`/strategies/${s.id}`} className="text-sm font-bold text-primary">مدیریت</Link>
                        <DeleteStrategyButton strategyId={s.id} compact />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>
          )}
        </>
      )}
    </div>
  );
}
