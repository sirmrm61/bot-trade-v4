import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, Badge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman } from "@/shared/utils";
import { TX_TYPE_LABELS } from "@/shared/constants";

export default async function AdminTransactionsPage() {
  const transactions = await prisma.walletTransaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { username: true } } },
  });

  return (
    <div>
      <PageHeader title="تراکنش‌های مالی" />
      <Card>
        <Table headers={["کاربر", "نوع", "مبلغ", "قبل", "بعد", "پیگیری", "ایجادکننده", "تاریخ"]}>
          {transactions.map((t) => (
            <tr key={t.id}>
              <td className="px-4 py-3 font-bold">{t.user.username}</td>
              <td className="px-4 py-3"><Badge tone={t.direction === "CREDIT" ? "success" : "danger"}>{TX_TYPE_LABELS[t.type] ?? t.type}</Badge></td>
              <td className="px-4 py-3 font-bold">{toman(t.amount)}</td>
              <td className="px-4 py-3 text-muted">{toman(t.balanceBefore)}</td>
              <td className="px-4 py-3 text-muted">{toman(t.balanceAfter)}</td>
              <td className="px-4 py-3 ltr text-xs text-muted">{t.referenceNumber}</td>
              <td className="px-4 py-3 text-xs text-muted">{t.createdById ? "مدیر" : "سیستم"}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(t.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
