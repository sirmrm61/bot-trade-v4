import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { createAgent, listAgents } from "@/modules/agent/service";
import { logActivity } from "@/modules/activity/service";

const schema = z.object({
  symbol: z.string().min(2).max(30).optional(),
  exchange: z.string().max(30).optional(),
  mode: z.enum(["PAPER", "REAL"]).optional(),
  maxPairs: z.number().int().min(1).max(10).optional(),
  tickIntervalSec: z.number().int().min(60).max(86400).optional(),
});

export const GET = api(async (_req, ctx) => {
  return { agents: await listAgents(ctx.userId) };
});

export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const agent = await createAgent(ctx.userId, input);
  await logActivity({ userId: ctx.userId, action: "CREATE_AGENT", entityType: "tradingAgent", entityId: agent.id });
  return { ok: true, agent };
});
