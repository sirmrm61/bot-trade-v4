import { api } from "@/infrastructure/http/api";
import { submitForReview } from "@/modules/marketplace/service";

export const POST = api(async (_req, ctx) => {
  const listing = await submitForReview(ctx.userId, ctx.params!.id);
  return { ok: true, listing };
});
