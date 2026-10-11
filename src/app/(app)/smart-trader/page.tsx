import { PageHeader } from "@/components/ui";
import { prisma } from "@/infrastructure/database/prisma";
import { SmartTraderMosaic } from "./mosaic";

export default async function SmartTraderPage() {
  const pairs = await prisma.pair.findMany({
    where: { active: true, quoteCurrency: "USDT" },
    select: { symbol: true, exchange: true },
    take: 2000,
  });

  return (
    <div>
      <PageHeader
        title="تریدر هوشمند"
        description="ایده‌های معاملاتی خودکار — روی هر کارت کلیک کنید تا اجرا شود"
      />
      <SmartTraderMosaic pairs={pairs} />
    </div>
  );
}
