import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, PageHeader } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";

export default async function ProfilePage() {
  const session = await currentSession();
  const user = await prisma.user.findUnique({ where: { id: session!.sub } });
  if (!user) return null;

  const rows: [string, string][] = [
    ["نام کاربری", user.username],
    ["ایمیل", user.email ?? "—"],
    ["موبایل", user.mobile ?? "—"],
    ["کد معرف شما", user.referralCode],
    ["شناسه تلگرام", user.telegramChatId ?? "—"],
    ["عضویت", jalaliDateTime(user.createdAt)],
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="پروفایل" />
      <Card>
        <dl className="divide-y divide-border">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-3">
              <dt className="text-sm text-muted">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
