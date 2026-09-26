import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";

export const GET = api(async (_req, ctx) => {
  const backtest = await prisma.backtest.findFirst({
    where: { id: ctx.params!.id, userId: ctx.userId },
    include: {
      strategy: { select: { name: true } },
      trades: { orderBy: { entryTime: "asc" } },
    },
  });
  if (!backtest) throw new AppError("NOT_FOUND", 404);
  return { backtest };
});
