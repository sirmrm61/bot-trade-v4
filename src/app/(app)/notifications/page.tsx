import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, PageHeader, Badge, EmptyState } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { MarkAllRead } from "./actions";

const SEV_TONE: Record<string, "info" | "success" | "warning" | "danger"> = {
  INFO: "info", SUCCESS: "success", WARNING: "warning", ERROR: "danger", CRITICAL: "danger",
};

export default async function NotificationsPage() {
  const session = await currentSession();
  const notifications = await prisma.notification.findMany({
    where: { userId: session!.sub },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const hasUnread = notifications.some((n) => !n.read);

  return (
    <div>
      <PageHeader title="اعلان‌ها" action={hasUnread ? <MarkAllRead /> : undefined} />
      {notifications.length === 0 ? (
        <EmptyState title="اعلانی ندارید" />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {notifications.map((n) => (
              <li key={n.id} className={`flex items-start gap-3 p-4 ${n.read ? "opacity-60" : ""}`}>
                <Badge tone={SEV_TONE[n.severity] ?? "info"}>{n.severity}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm">{n.title}</div>
                  <p className="mt-0.5 text-sm text-muted">{n.body}</p>
                </div>
                <span className="shrink-0 text-xs text-muted whitespace-nowrap">{jalaliDateTime(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
