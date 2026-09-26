import { api } from "@/infrastructure/http/api";
import { pauseLiveStrategy } from "@/modules/trading/live-engine";
import { logActivity } from "@/modules/activity/service";

export const POST = api(async (_req, ctx) => {
  const live = await pauseLiveStrategy(ctx.userId, ctx.params!.id);
  await logActivity({ userId: ctx.userId, action: "PAUSE", entityType: "liveStrategy", entityId: live.id });
  return { ok: true };
});
