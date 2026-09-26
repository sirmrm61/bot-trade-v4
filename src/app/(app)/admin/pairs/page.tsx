import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { SyncButton, TogglePair } from "./actions";

export default async function AdminPairsPage() {
  const pairs = await prisma.pair.findMany({ orderBy: [{ active: "desc" }, { symbol: "asc" }] });

  return (
    <div>
      <PageHeader title="جفت‌ارزها" description="همگام‌سازی دوره‌ای با نوبیتکس + مدیریت دستی" action={<SyncButton />} />
      <Card>
        <Table headers={["نماد", "ارز پایه", "ارز متقابل", "وضعیت معامله", "فعال", "آخرین همگام‌سازی", "عملیات"]}>
          {pairs.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-3 font-bold ltr">{p.symbol}</td>
              <td className="px-4 py-3 ltr">{p.baseCurrency}</td>
              <td className="px-4 py-3 ltr">{p.quoteCurrency}</td>
              <td className="px-4 py-3"><StatusBadge status={p.tradingStatus} /></td>
              <td className="px-4 py-3">{p.active ? "✓" : "✗"}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(p.syncedAt)}</td>
              <td className="px-4 py-3"><TogglePair id={p.id} active={p.active} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
