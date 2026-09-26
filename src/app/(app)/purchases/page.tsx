import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, Table, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman } from "@/shared/utils";
import { SubmitListingButton } from "./actions";

export default async function PurchasesPage() {
  const session = await currentSession();
  const [purchases, myListings] = await Promise.all([
    prisma.strategyPurchase.findMany({
      where: { buyerId: session!.sub },
      orderBy: { createdAt: "desc" },
      include: { listing: { select: { title: true } }, seller: { select: { username: true } } },
    }),
    prisma.marketplaceListing.findMany({
      where: { sellerId: session!.sub },
      orderBy: { createdAt: "desc" },
      include: { strategy: { select: { name: true } }, _count: { select: { purchases: true } } },
    }),
  ]);

  return (
    <div>
      <PageHeader title="خریدها و آگهی‌های من" />

      <Card>
        <CardTitle>استراتژی‌های خریداری‌شده</CardTitle>
        {purchases.length === 0 ? (
          <p className="text-sm text-muted">خریدی انجام نداده‌اید.</p>
        ) : (
          <Table headers={["استراتژی", "فروشنده", "قیمت", "انقضای دسترسی", "تاریخ"]}>
            {purchases.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 font-bold">{p.listing.title}</td>
                <td className="px-4 py-3">{p.seller.username}</td>
                <td className="px-4 py-3">{toman(p.price)}</td>
                <td className="px-4 py-3 text-sm">{p.expiresAt ? jalaliDateTime(p.expiresAt) : "دائمی"}</td>
                <td className="px-4 py-3 text-xs text-muted">{jalaliDateTime(p.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardTitle>آگهی‌های من در بازار</CardTitle>
        {myListings.length === 0 ? (
          <p className="text-sm text-muted">آگهی ندارید — از صفحه استراتژی می‌توانید ثبت کنید.</p>
        ) : (
          <Table headers={["عنوان", "استراتژی", "قیمت", "فروش", "وضعیت", "عملیات"]}>
            {myListings.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3 font-bold">{l.title}</td>
                <td className="px-4 py-3">{l.strategy.name}</td>
                <td className="px-4 py-3">{toman(l.price)}</td>
                <td className="px-4 py-3">{l._count.purchases}</td>
                <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                <td className="px-4 py-3">
                  {["DRAFT", "REJECTED"].includes(l.status) && <SubmitListingButton id={l.id} />}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
