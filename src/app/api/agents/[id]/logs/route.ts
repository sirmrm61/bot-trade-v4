import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { agentLogs } from "@/modules/agent/service";
import { AppError } from "@/shared/errors";

export const GET = api(async (_req, ctx) => {
  const agentId = ctx.params?.id ?? "";
  const agent = await prisma.tradingAgent.findFirst({ where: { id: agentId, userId: ctx.userId } });
  if (!agent) throw new AppError("NOT_FOUND", 404);
  return { logs: await agentLogs(agentId, 150) };
});
