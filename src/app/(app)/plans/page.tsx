import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { currentSubscription } from "@/modules/subscriptions/service";
import { Card, CardTitle, PageHeader, Badge } from "@/components/ui";
import { jalaliDate } from "@/shared/jalali";
import { toman, faNumber } from "@/shared/utils";
import { PlanBuyButton } from "./plan-buy";

export default async function PlansPage() {
  const session = await currentSession();
  const [plans, sub] = await Promise.all([
    prisma.plan.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] }),
    currentSubscription(session!.sub),
  ]);

  return (
    <div>
      <PageHeader title="پلن‌ها" description="پلن مناسب خود را انتخاب کنید — هزینه از کیف پول کسر می‌شود" />
      {sub && (
        <Card className="mb-6 border-primary/30 bg-primary/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm text-muted">اشتراک فعلی</div>
              <div className="text-lg font-black">{sub.plan.name}</div>
            </div>
            <div className="text-sm">
              تا <b>{jalaliDate(sub.expiresAt)}</b> — خرید جدید به اعتبار فعلی اضافه می‌شود
            </div>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.id} className={sub?.planId === p.id ? "border-primary" : ""}>
            <div className="flex items-center justify-between">
              <CardTitle className="mb-0">{p.name}</CardTitle>
              {sub?.planId === p.id && <Badge tone="success">فعلی</Badge>}
            </div>
            <div className="mt-4 text-3xl font-black">
              {p.price === 0 ? "رایگان" : toman(p.price)}
            </div>
            <ul className="mt-4 space-y-2 text-sm text-muted">
              <li>مدت: {faNumber(p.durationDays)} روز</li>
              <li>بک‌تست: {faNumber(p.backtestLimit)} بار</li>
              <li>استراتژی زنده همزمان: {faNumber(p.liveLimit)}</li>
            </ul>
            {p.description && <p className="mt-3 text-xs text-muted">{p.description}</p>}
            <div className="mt-5">
              {p.price === 0 ? (
                <span className="block rounded-xl bg-slate-100 py-2 text-center text-sm text-muted dark:bg-slate-800">پلن پیش‌فرض</span>
              ) : (
                <PlanBuyButton planId={p.id} price={p.price} />
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
