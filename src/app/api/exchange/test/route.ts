import { api } from "@/infrastructure/http/api";
import { testConnection } from "@/modules/exchanges/account-service";
import { z } from "zod";

export const POST = api(async (req, ctx) => {
  const body = z.object({ exchange: z.string().default("NOBITEX") }).parse(await req.json().catch(() => ({})));
  const { ok, balances } = await testConnection(ctx.userId, body.exchange.toUpperCase());
  return { ok, balances };
});
