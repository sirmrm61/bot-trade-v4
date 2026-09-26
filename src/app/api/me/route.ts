import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { currentSubscription, effectiveLimits, backtestUsage, liveUsage } from "@/modules/subscriptions/service";

export const GET = api(async (_req, ctx) => {
  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: {
      id: true, username: true, email: true, mobile: true, role: true,
      referralCode: true, telegramChatId: true, createdAt: true,
    },
  });
  const sub = await currentSubscription(ctx.userId);
  const limits = await effectiveLimits(ctx.userId);
  const wallet = await prisma.wallet.findUnique({ where: { userId: ctx.userId } });
  const exchange = await prisma.exchangeAccount.findFirst({
    where: { userId: ctx.userId },
    select: { id: true, exchange: true, apiKeyMask: true, status: true, lastCheckedAt: true },
  });
  return {
    user,
    subscription: sub ? { plan: sub.plan, status: sub.status, expiresAt: sub.expiresAt, graceEndsAt: sub.graceEndsAt } : null,
    limits: {
      backtestLimit: limits.backtestLimit,
      liveLimit: limits.liveLimit,
      backtestUsed: await backtestUsage(ctx.userId),
      liveUsed: await liveUsage(ctx.userId),
    },
    wallet: { balance: wallet?.balance ?? 0, currency: wallet?.currency ?? "IRT" },
    exchange,
  };
});
