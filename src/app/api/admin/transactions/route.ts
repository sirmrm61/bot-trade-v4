import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async () => {
  const transactions = await prisma.walletTransaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { username: true } } },
  });
  return { transactions };
}, { admin: true });
