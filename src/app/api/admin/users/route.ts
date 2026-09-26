import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { logActivity } from "@/modules/activity/service";

export const GET = api(async () => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, username: true, email: true, mobile: true, role: true, status: true,
      referralCode: true, createdAt: true,
      wallet: { select: { balance: true } },
      subscriptions: { orderBy: { expiresAt: "desc" }, take: 1, include: { plan: { select: { name: true } } } },
      exchangeAccounts: { select: { exchange: true, status: true, apiKeyMask: true } },
    },
  });
  return { users };
}, { admin: true });

const patchSchema = z.object({
  userId: z.string(),
  status: z.enum(["ACTIVE", "SUSPENDED", "RESTRICTED"]).optional(),
  role: z.enum(["USER", "ADMIN"]).optional(),
});

export const PATCH = api(async (req, ctx) => {
  const input = patchSchema.parse(await body(req));
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new AppError("NOT_FOUND", 404);
  const updated = await prisma.user.update({
    where: { id: input.userId },
    data: { status: input.status, role: input.role },
  });
  await logActivity({
    userId: ctx.userId, actorType: "ADMIN", action: "ADMIN_UPDATE_USER",
    entityType: "user", entityId: user.id,
    metadata: { status: input.status, role: input.role },
  });
  return { ok: true, user: { id: updated.id, status: updated.status, role: updated.role } };
}, { admin: true });
