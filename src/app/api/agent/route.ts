import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { agentAction } from "@/modules/agent/actions";

/**
 * Machine-facing endpoint for Devin CLI trading agents.
 * Auth: `Authorization: Bearer <AGENT_TOKEN>` + `X-Agent-Id` header —
 * each agent only sees its own userId/symbol, so it can never act on
 * another user's account or another pair.
 */

const schema = z.object({
  action: z.string().min(1).max(40),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const POST = api(async (req) => {
  const token = process.env.AGENT_TOKEN;
  if (!token) throw new AppError("FORBIDDEN", 403, { reason: "agent API disabled" });
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const ok = got.length === token.length &&
    timingSafeEqual(Buffer.from(got), Buffer.from(token));
  if (!ok) throw new AppError("UNAUTHORIZED", 401);

  const agentId = req.headers.get("x-agent-id") ?? "";
  const agent = await prisma.tradingAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.status !== "RUNNING") throw new AppError("FORBIDDEN", 403, { reason: "agent not running" });

  const input = schema.parse(await body(req));
  const result = await agentAction(agent, input.action, input.params ?? {});
  return { ok: true, result };
}, { public: true });
