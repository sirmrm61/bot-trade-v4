import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { stopLiveStrategy } from "@/modules/trading/live-engine";
import { logActivity } from "@/modules/activity/service";

const schema = z.object({ stopPolicy: z.enum(["CLOSE_ALL", "KEEP_MANAGING"]) });

export const POST = api(async (req, ctx) => {
  const { stopPolicy } = schema.parse(await body(req));
  await stopLiveStrategy(ctx.userId, ctx.params!.id, stopPolicy);
  await logActivity({ userId: ctx.userId, action: "STOP", entityType: "liveStrategy", entityId: ctx.params!.id, metadata: { stopPolicy } });
  return { ok: true };
});
