import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { scanWhales } from "@/modules/whales/service";

const scanSchema = z.object({
  market: z.enum(["SPOT", "PERPETUAL"]).optional(),
  count: z.number().int().min(1).max(25).optional(),
});

/** GET /api/whales — recent whale events. */
export const GET = api(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const take = Math.min(Number(searchParams.get("take")) || 50, 100);
  const items = await prisma.whaleEvent.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return { ok: true, items };
});

/** POST /api/whales — run a whale scan over top-ranked pairs. */
export const POST = api(async (req, ctx) => {
  const input = scanSchema.parse(await body(req));
  const result = await scanWhales(ctx.userId, input);
  return { ok: true, ...result };
});
