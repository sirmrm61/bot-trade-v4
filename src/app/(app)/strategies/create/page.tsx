import { prisma } from "@/infrastructure/database/prisma";
import { PageHeader, Card } from "@/components/ui";
import { currentSession } from "@/modules/auth/session";
import { StrategyBuilder } from "../builder";
import { SmartSelectDialog } from "../smart-select";

export default async function CreateStrategyPage() {
  const session = await currentSession();
  const pairs = await prisma.pair.findMany({ where: { active: true, quoteCurrency: "USDT" }, select: { symbol: true, exchange: true }, take: 2000 });
  const isAdmin = session?.role === "ADMIN";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="ساخت استراتژی"
        description="اندیکاتورها، وزن‌ها و مدیریت ریسک را تنظیم کنید"
        action={isAdmin ? <SmartSelectDialog pairs={pairs} /> : undefined}
      />
      <Card>
        <StrategyBuilder endpoint="/api/strategies" pairs={pairs} />
      </Card>
    </div>
  );
}
