import { api } from "@/infrastructure/http/api";
import { connectExchange, getBalances, disconnectExchange } from "@/modules/exchanges/account-service";
import { z } from "zod";

const Body = z.object({
  apiKey: z.string().min(1).optional(),
  apiSecret: z.string().min(1).optional(),
  apiPassphrase: z.string().optional(),
  exchange: z.string().default("NOBITEX"),
  action: z.enum(["connect", "disconnect"]).default("connect"),
});

export const POST = api(async (req, ctx) => {
  const body = Body.parse(await req.json());
  const exchange = body.exchange.toUpperCase();
  if (body.action === "disconnect") {
    await disconnectExchange(ctx.userId, exchange);
    return { disconnected: true };
  }
  const { account, balances } = await connectExchange({
    userId: ctx.userId,
    apiKey: body.apiKey!,
    apiSecret: body.apiSecret!,
    apiPassphrase: body.apiPassphrase,
    exchange,
  });
  return {
    exchange,
    balances,
    mask: account.apiKeyMask,
    connectedAt: account.updatedAt ?? account.createdAt,
  };
});

export const DELETE = api(async (req, ctx) => {
  const exchange = new URL(req.url).searchParams.get("exchange") ?? "NOBITEX";
  await disconnectExchange(ctx.userId, exchange);
  return { disconnected: true };
});

export const GET = api(async (req, ctx) => {
  const exchange = new URL(req.url).searchParams.get("exchange") ?? "NOBITEX";
  return { balances: await getBalances(ctx.userId, exchange) };
});
