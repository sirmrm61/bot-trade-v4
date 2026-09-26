import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async () => {
  const subscriptions = await prisma.userSubscription.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { username: true } }, plan: { select: { name: true } } },
  });
  return { subscriptions };
}, { admin: true });
