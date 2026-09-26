import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, StatCard, Table, Badge, EmptyState } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { toman } from "@/shared/utils";
import { TX_TYPE_LABELS } from "@/shared/constants";
import { ChargeForm } from "./charge-form";

export default async function WalletPage() {
  const session = await currentSession();
  const wallet = await prisma.wallet.findUnique({ where: { userId: session!.sub } });
  const transactions = await prisma.walletTransaction.findMany({
    where: { userId: session!.sub },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader title="کیف پول" description="موجودی و تاریخچه تراکنش‌های مالی" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="موجودی فعلی" value={toman(wallet?.balance ?? 0)} />
        <StatCard label="واحد" value="تومان" />
        <StatCard label="تعداد تراکنش‌ها" value={transactions.length.toLocaleString("fa-IR")} />
      </div>

      <Card className="mt-6">
        <CardTitle>شارژ کیف پول</CardTitle>
        <ChargeForm />
      </Card>

      <Card className="mt-6">
        <CardTitle>تراکنش‌ها</CardTitle>
        {transactions.length === 0 ? (
          <EmptyState title="تراکنشی وجود ندارد" hint="پس از شارژ یا خرید، تراکنش‌ها اینجا نمایش داده می‌شوند" />
        ) : (
          <Table headers={["نوع", "مبلغ", "مانده", "شماره پیگیری", "توضیح", "تاریخ"]}>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-3">
                  <Badge tone={t.direction === "CREDIT" ? "success" : "danger"}>
                    {TX_TYPE_LABELS[t.type] ?? t.type}
                  </Badge>
                </td>
                <td className="px-4 py-3 font-bold">
                  <span className={t.direction === "CREDIT" ? "text-success" : "text-danger"}>
                    {t.direction === "CREDIT" ? "+" : "−"}{toman(t.amount)}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted">{toman(t.balanceAfter)}</td>
                <td className="px-4 py-3 ltr text-xs text-muted">{t.referenceNumber}</td>
                <td className="px-4 py-3 text-xs text-muted">{t.description ?? "—"}</td>
                <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(t.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
