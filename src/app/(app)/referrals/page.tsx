import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, Table, EmptyState, StatCard, Badge } from "@/components/ui";
import { CopyLink } from "./copy";
import { faNumber } from "@/shared/utils";

export default async function ReferralsPage() {
  const session = await currentSession();
  const user = await prisma.user.findUnique({ where: { id: session!.sub } });
  const referrals = await prisma.referral.findMany({
    where: { referrerId: session!.sub },
    orderBy: { createdAt: "desc" },
    include: { referee: { select: { username: true } } },
  });
  const completed = referrals.filter((r) => r.completed).length;
  const link = `${process.env.APP_URL ?? "http://localhost:3000"}/register?ref=${user?.referralCode}`;

  return (
    <div>
      <PageHeader title="دعوت دوستان" description="با هر رفرال کامل (ثبت‌نام + اتصال API + اولین معامله زنده) ۷ روز اشتراک هدیه بگیرید" />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="دعوت‌شده‌ها" value={faNumber(referrals.length)} />
        <StatCard label="رفرال کامل" value={faNumber(completed)} tone="success" />
        <StatCard label="کد معرف" value={user?.referralCode ?? "—"} />
      </div>
      <Card className="mb-6">
        <CardTitle>لینک دعوت شما</CardTitle>
        <CopyLink link={link} />
      </Card>
      <Card>
        <CardTitle>وضعیت دعوت‌ها</CardTitle>
        {referrals.length === 0 ? (
          <EmptyState title="هنوز کسی را دعوت نکرده‌اید" />
        ) : (
          <Table headers={["کاربر", "ثبت‌نام", "اتصال API", "اولین معامله", "پاداش"]}>
            {referrals.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 font-bold">{r.referee.username}</td>
                <td className="px-4 py-3"><Badge tone={r.registered ? "success" : "default"}>{r.registered ? "✓" : "—"}</Badge></td>
                <td className="px-4 py-3"><Badge tone={r.apiConnected ? "success" : "default"}>{r.apiConnected ? "✓" : "—"}</Badge></td>
                <td className="px-4 py-3"><Badge tone={r.firstLiveTrade ? "success" : "default"}>{r.firstLiveTrade ? "✓" : "—"}</Badge></td>
                <td className="px-4 py-3"><Badge tone={r.completed ? "success" : "info"}>{r.completed ? `+${faNumber(r.bonusDays)} روز` : "در انتظار"}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
