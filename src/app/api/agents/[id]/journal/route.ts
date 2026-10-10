import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { journalRecent } from "@/modules/agent/journal";
import { AppError } from "@/shared/errors";

export const GET = api(async (req, ctx) => {
  const agentId = ctx.params?.id ?? "";
  const agent = await prisma.tradingAgent.findFirst({ where: { id: agentId, userId: ctx.userId } });
  if (!agent) throw new AppError("NOT_FOUND", 404);
  const type = new URL(req.url).searchParams.get("type") ?? undefined;
  return { journal: await journalRecent(agentId, 100, type as never) };
});
