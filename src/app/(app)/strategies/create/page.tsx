import { prisma } from "@/infrastructure/database/prisma";
import { PageHeader, Card, CardTitle } from "@/components/ui";
import { currentSession } from "@/modules/auth/session";
import { StrategyBuilder } from "../builder";
import { SmartSelectForm } from "../smart-select";

export default async function CreateStrategyPage() {
  const session = await currentSession();
  const pairs = await prisma.pair.findMany({ where: { active: true }, select: { symbol: true, exchange: true }, take: 2000 });
  const isAdmin = session?.role === "ADMIN";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="ساخت استراتژی" description="اندیکاتورها، وزن‌ها و مدیریت ریسک را تنظیم کنید" />
      {isAdmin && (
        <Card>
          <CardTitle>انتخاب هوشمند <span className="text-xs font-normal text-muted">(ویژه ادمین)</span></CardTitle>
          <p className="mb-4 text-xs text-muted">
            سیستم همه‌ی ترکیب‌های اندیکاتورها را روی داده تاریخی تست می‌کند و استراتژی با بیشترین سیگنال خرید/فروش را می‌سازد.
          </p>
          <SmartSelectForm pairs={pairs} />
        </Card>
      )}
      <Card>
        <StrategyBuilder endpoint="/api/strategies" pairs={pairs} />
      </Card>
    </div>
  );
}
