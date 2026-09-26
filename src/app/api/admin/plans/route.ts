import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { logActivity } from "@/modules/activity/service";

export const GET = api(async () => {
  const plans = await prisma.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { price: "asc" }] });
  return { plans };
}, { admin: true });

const planSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  slug: z.string().min(1),
  durationDays: z.number().int().positive(),
  price: z.number().int().min(0),
  backtestLimit: z.number().int().min(0),
  liveLimit: z.number().int().min(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  description: z.string().optional(),
});

export const POST = api(async (req, ctx) => {
  const input = planSchema.parse(await body(req));
  const { id, ...data } = input;
  const plan = id
    ? await prisma.plan.update({ where: { id }, data })
    : await prisma.plan.create({ data });
  await logActivity({
    userId: ctx.userId, actorType: "ADMIN", action: "ADMIN_SAVE_PLAN",
    entityType: "plan", entityId: plan.id, metadata: { name: plan.name },
  });
  return { ok: true, plan };
}, { admin: true });
