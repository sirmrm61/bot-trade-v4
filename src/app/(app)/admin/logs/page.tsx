import { prisma } from "@/infrastructure/database/prisma";
import { Card, PageHeader, Table, Badge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";

const ACTOR_LABELS: Record<string, string> = { USER: "کاربر", ADMIN: "مدیر", SYSTEM: "سیستم", WORKER: "ورکر" };

export default async function AdminLogsPage() {
  const logs = await prisma.activityLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { username: true } } },
  });

  return (
    <div>
      <PageHeader title="لاگ فعالیت‌ها" description="تمام رویدادهای مهم سیستم" />
      <Card>
        <Table headers={["کنش", "کاربر", "عامل", "موجودیت", "IP", "تاریخ"]}>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="px-4 py-3"><Badge tone="info">{l.action}</Badge></td>
              <td className="px-4 py-3">{l.user?.username ?? "—"}</td>
              <td className="px-4 py-3 text-xs">{ACTOR_LABELS[l.actorType] ?? l.actorType}</td>
              <td className="px-4 py-3 text-xs text-muted">{l.entityType ?? "—"}/{l.entityId?.slice(0, 8) ?? ""}</td>
              <td className="px-4 py-3 text-xs text-muted ltr">{l.ip ?? "—"}</td>
              <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{jalaliDateTime(l.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
