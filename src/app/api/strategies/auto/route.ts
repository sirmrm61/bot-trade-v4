import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { autoGenerateStrategies } from "@/modules/strategies/auto-generate";

const schema = z.object({
  count: z.number().int().min(1).max(10).optional(),
});

/**
 * POST /api/strategies/auto — pick the top-scored pairs from the scalping
 * scanner, evaluate candidate timeframes on real candles, and create one
 * SIGNAL strategy per surviving pair. Heavy: a full scan + candle fetches.
 */
export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const result = await autoGenerateStrategies(ctx.userId, input);
  return { ok: true, ...result };
});
