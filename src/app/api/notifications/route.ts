import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

export const GET = api(async (_req, ctx) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const unread = await prisma.notification.count({ where: { userId: ctx.userId, read: false } });
  return { notifications, unread };
});

export const POST = api(async (req, ctx) => {
  const { ids } = (await body(req)) as { ids?: string[] };
  await prisma.notification.updateMany({
    where: { userId: ctx.userId, ...(ids?.length ? { id: { in: ids } } : {}) },
    data: { read: true },
  });
  return { ok: true };
});
