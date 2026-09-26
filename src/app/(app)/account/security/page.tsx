import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, Badge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";

export default async function SecurityPage() {
  const session = await currentSession();
  const sessions = await prisma.session.findMany({
    where: { userId: session!.sub, revokedAt: null },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="امنیت" />
      <Card>
        <CardTitle>احراز هویت دو مرحله‌ای (2FA)</CardTitle>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">در نسخه فعلی اختیاری است — به‌زودی فعال می‌شود.</p>
          <Badge>غیرفعال</Badge>
        </div>
      </Card>
      <Card className="mt-4">
        <CardTitle>نشست‌های فعال</CardTitle>
        <ul className="divide-y divide-border">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-3 text-sm">
              <span className="text-muted">{s.ip ?? "—"} · {s.userAgent?.slice(0, 40) ?? ""}</span>
              <span className="text-xs text-muted">{jalaliDateTime(s.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
