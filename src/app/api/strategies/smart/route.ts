import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { runSmartSelect } from "@/modules/strategies/smart-select";

const schema = z.object({
  symbol: z.string().min(2),
  timeframe: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  initialBalance: z.number().positive(),
  feePct: z.number().min(0).max(5).optional(),
  slippagePct: z.number().min(0).max(5).optional(),
  exchange: z.string().optional(),
});

// Admin-only for now — heavy computation across the whole indicator space.
export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const result = await runSmartSelect({
    userId: ctx.userId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    startDate: new Date(input.startDate),
    endDate: input.endDate.includes("T")
      ? new Date(input.endDate)
      : new Date(`${input.endDate}T23:59:59.999Z`),
    initialBalance: input.initialBalance,
    feePct: input.feePct,
    slippagePct: input.slippagePct,
    exchange: input.exchange,
  });
  return { ok: true, ...result };
}, { admin: true });
