import { prisma } from "@/infrastructure/database/prisma";
import { Card, CardTitle, PageHeader, Table } from "@/components/ui";
import { toman } from "@/shared/utils";
import { ChargeForm } from "./charge-form";

export default async function AdminWalletsPage() {
  const [wallets, users] = await Promise.all([
    prisma.wallet.findMany({ orderBy: { balance: "desc" }, include: { user: { select: { username: true } } }, take: 200 }),
    prisma.user.findMany({ select: { id: true, username: true }, orderBy: { username: "asc" } }),
  ]);

  return (
    <div>
      <PageHeader title="کیف پول‌ها" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>موجودی‌ها</CardTitle>
          <Table headers={["کاربر", "موجودی", "واحد"]}>
            {wallets.map((w) => (
              <tr key={w.id}>
                <td className="px-4 py-3 font-bold">{w.user.username}</td>
                <td className="px-4 py-3">{toman(w.balance)}</td>
                <td className="px-4 py-3 text-muted">{w.currency}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card>
          <CardTitle>شارژ دستی کیف پول</CardTitle>
          <ChargeForm users={users} />
        </Card>
      </div>
    </div>
  );
}
