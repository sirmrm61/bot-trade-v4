import { api } from "@/infrastructure/http/api";
import { stopAgent } from "@/modules/agent/service";
import { logActivity } from "@/modules/activity/service";

export const POST = api(async (_req, ctx) => {
  const agent = await stopAgent(ctx.userId, ctx.params?.id ?? "");
  await logActivity({ userId: ctx.userId, action: "STOP_AGENT", entityType: "tradingAgent", entityId: agent.id });
  return { ok: true, status: agent.status };
});
