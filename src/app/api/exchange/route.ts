import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { connectExchange, disconnectExchange } from "@/modules/exchanges/account-service";
import { prisma } from "@/infrastructure/database/prisma";

const connectSchema = z.object({
  apiKey: z.string().min(8),
  apiSecret: z.string().min(4),
});

export const GET = api(async (_req, ctx) => {
  const account = await prisma.exchangeAccount.findFirst({
    where: { userId: ctx.userId },
    select: { id: true, exchange: true, label: true, apiKeyMask: true, status: true, lastCheckedAt: true, lastError: true, createdAt: true },
  });
  return { account };
});

export const POST = api(async (req, ctx) => {
  const { apiKey, apiSecret } = connectSchema.parse(await body(req));
  const { account, balances } = await connectExchange({ userId: ctx.userId, apiKey, apiSecret });
  return {
    ok: true,
    account: { id: account.id, exchange: account.exchange, status: account.status, apiKeyMask: account.apiKeyMask },
    balances,
  };
});

export const DELETE = api(async (_req, ctx) => {
  await disconnectExchange(ctx.userId);
  return { ok: true };
});
