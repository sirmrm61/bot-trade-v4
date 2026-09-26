import { api } from "@/infrastructure/http/api";
import { testConnection, getBalances } from "@/modules/exchanges/account-service";
import { AppError } from "@/shared/errors";

export const POST = api(async (_req, ctx) => {
  const { ok, balances } = await testConnection(ctx.userId);
  if (!ok) throw new AppError("EXCHANGE_CONNECTION_FAILED", 502);
  return { ok, balances };
});

export const GET = api(async (_req, ctx) => {
  const balances = await getBalances(ctx.userId);
  return { balances };
});
