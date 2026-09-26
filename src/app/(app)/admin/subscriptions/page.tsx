import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman } from "@/shared/utils";

export default async function AdminSubscriptionsPage() {
  const subs = await prisma.userSubscription.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { username: true } }, plan: { select: { name: true } } },
  });

  return (
    <div>
      <PageHeader title="اشتراک‌ها" />
      <Card>
        <Table headers={["کاربر", "پلن", "شروع", "انقضا", "مهلت ارفاق", "مبلغ", "منبع", "وضعیت"]}>
          {subs.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-3 font-bold">{s.user.username}</td>
              <td className="px-4 py-3">{s.plan.name}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(s.startsAt)}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(s.expiresAt)}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{s.graceEndsAt ? jalaliDateTime(s.graceEndsAt) : "—"}</td>
              <td className="px-4 py-3">{toman(s.pricePaid)}</td>
              <td className="px-4 py-3 text-xs">{s.source}</td>
              <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
