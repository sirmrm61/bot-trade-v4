import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { deleteStrategy, updateStrategy, type StrategyInput } from "@/modules/strategies/service";
import { AppError } from "@/shared/errors";

export const GET = api(async (_req, ctx) => {
  const strategy = await prisma.strategy.findFirst({
    where: { id: ctx.params!.id, userId: ctx.userId, status: { not: "DELETED" } },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, include: { indicators: true } },
      backtests: { orderBy: { createdAt: "desc" } },
      liveStrategies: true,
    },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404);
  return { strategy };
});

export const PUT = api(async (req, ctx) => {
  const input = (await body(req)) as StrategyInput;
  const version = await updateStrategy(ctx.userId, ctx.params!.id, input);
  return { ok: true, version };
});

export const DELETE = api(async (_req, ctx) => {
  const result = await deleteStrategy(ctx.userId, ctx.params!.id);
  return { ok: true, soft: result.soft };
});
