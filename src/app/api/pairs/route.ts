import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async () => {
  const pairs = await prisma.pair.findMany({
    where: { active: true },
    orderBy: { symbol: "asc" },
    select: { symbol: true, baseCurrency: true, quoteCurrency: true, tradingStatus: true },
  });
  return { pairs };
});
