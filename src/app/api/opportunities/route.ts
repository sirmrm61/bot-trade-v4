import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { scanOpportunities, evaluateOutcomes } from "@/modules/opportunity/service";

const scanSchema = z.object({
  market: z.enum(["SPOT", "PERPETUAL"]).optional(),
  count: z.number().int().min(1).max(25).optional(),
  candleTimeframe: z.enum(["1m", "3m", "5m", "15m", "30m", "1h"]).optional(),
});

/** GET /api/opportunities — list recent, lazily evaluating stale outcomes. */
export const GET = api(async (req, ctx) => {
  await evaluateOutcomes().catch(() => {});
  const { searchParams } = new URL(req.url);
  const take = Math.min(Number(searchParams.get("take")) || 50, 100);
  const items = await prisma.opportunity.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return { ok: true, items };
});

/** POST /api/opportunities — run a fresh scan and persist opportunities. */
export const POST = api(async (req, ctx) => {
  const input = scanSchema.parse(await body(req));
  const result = await scanOpportunities(ctx.userId, input);
  return { ok: true, ...result };
});
