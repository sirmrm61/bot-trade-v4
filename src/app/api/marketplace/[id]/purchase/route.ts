import { api, body } from "@/infrastructure/http/api";
import { purchaseStrategy } from "@/modules/marketplace/service";

export const POST = api(async (req, ctx) => {
  const { idempotencyKey } = (await body(req)) as { idempotencyKey?: string };
  const purchase = await purchaseStrategy({ buyerId: ctx.userId, listingId: ctx.params!.id, idempotencyKey });
  return { ok: true, purchase };
});
