import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, StatusBadge, Badge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { EXCHANGE_IDS, EXCHANGE_LABELS, type ExchangeId } from "@/shared/constants";
import { cn } from "@/shared/utils";
import Link from "next/link";
import { SyncButton, TogglePair } from "./actions";

export default async function AdminPairsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const exchange = sp.exchange?.toUpperCase();
  const q = sp.q?.trim().toUpperCase();

  const [pairs, counts] = await Promise.all([
    prisma.pair.findMany({
      where: {
        ...(exchange ? { exchange } : {}),
        ...(q ? { symbol: { contains: q } } : {}),
      },
      orderBy: [{ active: "desc" }, { exchange: "asc" }, { symbol: "asc" }],
      take: 500,
    }),
    prisma.pair.groupBy({ by: ["exchange"], _count: { _all: true } }),
  ]);
  const countOf = (id: string) => counts.find((c) => c.exchange === id)?._count._all ?? 0;

  const tabHref = (ex?: string) =>
    `/admin/pairs?${new URLSearchParams({ ...(ex ? { exchange: ex } : {}), ...(q ? { q } : {}) })}`;

  return (
    <div>
      <PageHeader
        title="جفت‌ارزها"
        description="همگام‌سازی دوره‌ای با صرافی‌های پیکربندی‌شده + مدیریت دستی"
        action={<SyncButton exchange={exchange} />}
      />

      {/* exchange tabs + symbol search */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={tabHref()}
          className={cn("rounded-xl px-4 py-1.5 text-sm font-medium border",
            !exchange ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-slate-100 dark:hover:bg-slate-800")}>
          همه ({counts.reduce((a, c) => a + c._count._all, 0)})
        </Link>
        {EXCHANGE_IDS.map((ex: ExchangeId) => (
          <Link key={ex} href={tabHref(ex)}
            className={cn("rounded-xl px-4 py-1.5 text-sm font-medium border",
              exchange === ex ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-slate-100 dark:hover:bg-slate-800")}>
            {EXCHANGE_LABELS[ex]} ({countOf(ex)})
          </Link>
        ))}
        <form method="get" className="ms-auto flex items-center gap-2">
          {exchange && <input type="hidden" name="exchange" value={exchange} />}
          <input
            name="q" defaultValue={sp.q ?? ""} dir="ltr" placeholder="جستجوی نماد…"
            className="w-44 rounded-xl border border-border bg-card px-3 py-1.5 text-sm outline-none focus:border-primary"
          />
          <button className="rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            جستجو
          </button>
        </form>
      </div>

      <Card>
        <Table headers={["نماد", "صرافی", "ارز پایه", "ارز متقابل", "وضعیت معامله", "فعال", "آخرین همگام‌سازی", "عملیات"]}>
          {pairs.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-3 font-bold ltr">{p.symbol}</td>
              <td className="px-4 py-3">
                <Badge tone="info">{EXCHANGE_LABELS[p.exchange as ExchangeId] ?? p.exchange}</Badge>
              </td>
              <td className="px-4 py-3 ltr">{p.baseCurrency}</td>
              <td className="px-4 py-3 ltr">{p.quoteCurrency}</td>
              <td className="px-4 py-3"><StatusBadge status={p.tradingStatus} /></td>
              <td className="px-4 py-3">{p.active ? "✓" : "✗"}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(p.syncedAt)}</td>
              <td className="px-4 py-3"><TogglePair id={p.id} active={p.active} /></td>
            </tr>
          ))}
        </Table>
        {pairs.length === 0 && (
          <div className="py-10 text-center text-sm text-muted">
            {exchange
              ? `هنوز جفتی برای ${EXCHANGE_LABELS[exchange as ExchangeId] ?? exchange} همگام نشده — دکمه «همگام‌سازی همین صرافی» را بزنید.`
              : "جفتی یافت نشد."}
          </div>
        )}
        {pairs.length === 500 && (
          <div className="py-3 text-center text-xs text-muted">فقط ۵۰۰ ردیف اول نمایش داده می‌شود — با جستجو یا فیلتر صرافی محدود کنید.</div>
        )}
      </Card>
    </div>
  );
}
