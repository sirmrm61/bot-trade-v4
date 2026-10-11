import { PageHeader } from "@/components/ui";
import { prisma } from "@/infrastructure/database/prisma";
import { ScalpPanel } from "./panel";

export default async function ScalpingPage() {
  const pairs = await prisma.pair.findMany({
    where: { active: true, quoteCurrency: "USDT" },
    select: { symbol: true, exchange: true },
    take: 2000,
  });

  return (
    <div>
      <PageHeader
        title="اسکالپ اسکنر"
        description="ارزیابی و رتبه‌بندی جفت‌ارزها برای معاملات کوتاه‌مدت — ابزار تحلیل، نه توصیه معاملاتی"
      />
      <ScalpPanel pairs={pairs} />
    </div>
  );
}
