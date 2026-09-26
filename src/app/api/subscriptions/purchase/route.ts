import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { purchasePlan } from "@/modules/subscriptions/service";
import { logActivity } from "@/modules/activity/service";

const schema = z.object({ planId: z.string().min(1), idempotencyKey: z.string().optional() });

export const POST = api(async (req, ctx) => {
  const { planId, idempotencyKey } = schema.parse(await body(req));
  const sub = await purchasePlan({ userId: ctx.userId, planId, idempotencyKey });
  await logActivity({ userId: ctx.userId, action: "SUBSCRIPTION", entityType: "subscription", entityId: sub.id });
  return { ok: true, subscription: sub };
});
