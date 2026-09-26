import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { requestBacktest } from "@/modules/backtest/service";

const schema = z.object({
  strategyId: z.string(),
  versionId: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  initialBalance: z.number().positive(),
  feePct: z.number().min(0).max(5).optional(),
  slippagePct: z.number().min(0).max(5).optional(),
  partialFill: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

export const GET = api(async (_req, ctx) => {
  const backtests = await prisma.backtest.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    include: { strategy: { select: { name: true } } },
  });
  return { backtests };
});

/** Date-only input ("2026-09-21") means the whole day → normalize to end-of-day UTC. */
function parseEndDate(s: string): Date {
  return new Date(s.includes("T") ? s : `${s}T23:59:59.999Z`);
}

export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const bt = await requestBacktest({
    userId: ctx.userId,
    strategyId: input.strategyId,
    versionId: input.versionId,
    startDate: new Date(input.startDate),
    endDate: parseEndDate(input.endDate),
    initialBalance: input.initialBalance,
    feePct: input.feePct,
    slippagePct: input.slippagePct,
    partialFill: input.partialFill,
    idempotencyKey: input.idempotencyKey,
  });
  return { ok: true, backtest: bt };
});
