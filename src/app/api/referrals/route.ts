import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async (_req, ctx) => {
  const referrals = await prisma.referral.findMany({
    where: { referrerId: ctx.userId },
    orderBy: { createdAt: "desc" },
    include: { referee: { select: { username: true, createdAt: true } } },
  });
  return { referrals };
});
