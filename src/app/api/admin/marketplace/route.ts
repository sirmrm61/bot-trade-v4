import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { reviewListing } from "@/modules/marketplace/service";

export const GET = api(async () => {
  const listings = await prisma.marketplaceListing.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      seller: { select: { username: true } },
      strategy: { select: { name: true } },
      version: { select: { symbol: true, timeframe: true } },
      _count: { select: { purchases: true } },
    },
  });
  return { listings };
}, { admin: true });

const reviewSchema = z.object({
  listingId: z.string(),
  approve: z.boolean(),
  note: z.string().optional(),
});

export const POST = api(async (req, ctx) => {
  const input = reviewSchema.parse(await body(req));
  const listing = await reviewListing({ adminId: ctx.userId, ...input });
  return { ok: true, listing };
}, { admin: true });
