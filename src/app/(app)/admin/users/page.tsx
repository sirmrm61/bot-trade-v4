import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, StatusBadge, Badge } from "@/components/ui";
import { jalaliDate } from "@/shared/jalali";
import { toman } from "@/shared/utils";
import { UserActions } from "./actions";

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      wallet: true,
      subscriptions: { orderBy: { expiresAt: "desc" }, take: 1, include: { plan: true } },
      exchangeAccounts: { select: { status: true, apiKeyMask: true } },
    },
    take: 300,
  });

  return (
    <div>
      <PageHeader title="کاربران" />
      <Card>
        <Table headers={["کاربر", "پلن", "کیف پول", "صرافی", "نقش", "وضعیت", "عضویت", "عملیات"]}>
          {users.map((u) => (
            <tr key={u.id}>
              <td className="px-4 py-3">
                <div className="font-bold">{u.username}</div>
                <div className="text-xs text-muted">{u.email ?? u.mobile ?? ""}</div>
              </td>
              <td className="px-4 py-3">
                {u.subscriptions[0] ? (
                  <div>
                    <div className="text-sm">{u.subscriptions[0].plan.name}</div>
                    <div className="text-xs text-muted">تا {jalaliDate(u.subscriptions[0].expiresAt)}</div>
                  </div>
                ) : "—"}
              </td>
              <td className="px-4 py-3">{toman(u.wallet?.balance ?? 0)}</td>
              <td className="px-4 py-3">
                {u.exchangeAccounts[0] ? (
                  <Badge tone={u.exchangeAccounts[0].status === "CONNECTED" ? "success" : "danger"}>
                    {u.exchangeAccounts[0].apiKeyMask}
                  </Badge>
                ) : "—"}
              </td>
              <td className="px-4 py-3"><Badge tone={u.role === "ADMIN" ? "warning" : "default"}>{u.role === "ADMIN" ? "مدیر" : "کاربر"}</Badge></td>
              <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDate(u.createdAt)}</td>
              <td className="px-4 py-3"><UserActions userId={u.id} status={u.status} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
