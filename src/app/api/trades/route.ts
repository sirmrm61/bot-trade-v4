import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async (_req, ctx) => {
  const trades = await prisma.trade.findMany({
    where: { userId: ctx.userId },
    orderBy: { openedAt: "desc" },
    take: 200,
    include: { liveStrategy: { include: { strategy: { select: { name: true } } } } },
  });
  return { trades };
});
