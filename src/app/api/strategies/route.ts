import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { createStrategy, type StrategyInput } from "@/modules/strategies/service";

export const GET = api(async (_req, ctx) => {
  const strategies = await prisma.strategy.findMany({
    where: { userId: ctx.userId, status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1, include: { indicators: true } },
      backtests: { orderBy: { createdAt: "desc" }, take: 1 },
      liveStrategies: { where: { status: { in: ["RUNNING", "PAUSED", "STARTING", "DEGRADED"] } } },
    },
  });
  return { strategies };
});

export const POST = api(async (req, ctx) => {
  const input = (await body(req)) as StrategyInput;
  const result = await createStrategy(ctx.userId, input);
  return { ok: true, strategy: result.strategy, version: result.version };
});
