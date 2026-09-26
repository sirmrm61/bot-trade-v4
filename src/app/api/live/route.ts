import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { startLiveStrategy } from "@/modules/trading/live-engine";
import { logActivity } from "@/modules/activity/service";

const schema = z.object({
  strategyId: z.string(),
  versionId: z.string().optional(),
  allocatedCapital: z.number().positive(),
  mode: z.enum(["REAL", "PAPER"]).optional(),
  paper: z.boolean().optional(),
});

export const GET = api(async (_req, ctx) => {
  const lives = await prisma.liveStrategy.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    include: {
      strategy: { select: { name: true } },
      version: { select: { versionNumber: true, timeframe: true, symbol: true } },
      trades: { orderBy: { openedAt: "desc" }, take: 10 },
    },
  });
  return { lives };
});

export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const live = await startLiveStrategy({
    userId: ctx.userId,
    strategyId: input.strategyId,
    versionId: input.versionId,
    allocatedCapital: input.allocatedCapital,
    mode: input.mode ?? (input.paper ? "PAPER" : "REAL"),
  });
  await logActivity({ userId: ctx.userId, action: "START_LIVE", entityType: "liveStrategy", entityId: live.id });
  return { ok: true, live };
});
