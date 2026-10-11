import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async (req) => {
  const q = new URL(req.url).searchParams;
  const exchange = q.get("exchange")?.toUpperCase();
  // base quote currency is USDT — pass quote=all to list IRT/other markets too
  const quote = (q.get("quote") ?? "USDT").toUpperCase();
  const pairs = await prisma.pair.findMany({
    where: { active: true, ...(exchange ? { exchange } : {}), ...(quote !== "ALL" ? { quoteCurrency: quote } : {}) },
    orderBy: { symbol: "asc" },
    select: { symbol: true, baseCurrency: true, quoteCurrency: true, tradingStatus: true, exchange: true },
  });
  return { pairs };
});
