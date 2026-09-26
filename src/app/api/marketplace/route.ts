import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { createListing } from "@/modules/marketplace/service";

const schema = z.object({
  strategyId: z.string(),
  title: z.string().min(2),
  description: z.string().optional(),
  price: z.number().nonnegative(),
  subscriptionDays: z.number().int().min(0).optional(),
  imageUrl: z.string().optional(),
});

// public catalogue
export const GET = api(async () => {
  const listings = await prisma.marketplaceListing.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    include: {
      seller: { select: { username: true } },
      version: { select: { symbol: true, timeframe: true, versionNumber: true } },
      strategy: {
        select: {
          name: true,
          backtests: { where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, take: 1,
            select: { profitPct: true, winRate: true, maxDrawdown: true, totalTrades: true } },
        },
      },
    },
  });
  return { listings };
});

export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const listing = await createListing({ userId: ctx.userId, ...input });
  return { ok: true, listing };
});
