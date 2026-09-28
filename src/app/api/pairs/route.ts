import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async (req) => {
  const exchange = new URL(req.url).searchParams.get("exchange")?.toUpperCase();
  const pairs = await prisma.pair.findMany({
    where: { active: true, ...(exchange ? { exchange } : {}) },
    orderBy: { symbol: "asc" },
    select: { symbol: true, baseCurrency: true, quoteCurrency: true, tradingStatus: true, exchange: true },
  });
  return { pairs };
});
