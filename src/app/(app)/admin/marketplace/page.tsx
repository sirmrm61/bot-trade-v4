import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman } from "@/shared/utils";
import { ReviewButtons } from "./actions";

export default async function AdminMarketplacePage() {
  const listings = await prisma.marketplaceListing.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      seller: { select: { username: true } },
      strategy: { select: { name: true } },
      version: { select: { symbol: true, timeframe: true } },
      _count: { select: { purchases: true } },
    },
  });

  return (
    <div>
      <PageHeader title="مدیریت بازار" description="تأیید یا رد آگهی‌های استراتژی" />
      <Card>
        <Table headers={["عنوان", "فروشنده", "نماد", "قیمت", "فروش", "وضعیت", "تاریخ", "عملیات"]}>
          {listings.map((l) => (
            <tr key={l.id}>
              <td className="px-4 py-3 font-bold">{l.title}</td>
              <td className="px-4 py-3">{l.seller.username}</td>
              <td className="px-4 py-3 ltr">{l.version.symbol} · {l.version.timeframe}</td>
              <td className="px-4 py-3">{toman(l.price)}</td>
              <td className="px-4 py-3">{l._count.purchases}</td>
              <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
              <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(l.createdAt)}</td>
              <td className="px-4 py-3">
                {l.status === "PENDING_REVIEW" && <ReviewButtons id={l.id} />}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
