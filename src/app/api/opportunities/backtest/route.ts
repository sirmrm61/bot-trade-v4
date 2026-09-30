import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { runScannerBacktest } from "@/modules/opportunity/service";

const schema = z.object({
  symbol: z.string().min(1),
  exchange: z.string().min(1),
  timeframe: z.enum(["1m", "3m", "5m", "15m", "30m", "1h"]),
  days: z.number().int().min(3).max(90).optional(),
  costPct: z.number().min(0).max(10).optional(),
});

/** POST /api/opportunities/backtest — replay the scanner logic on history. */
export const POST = api(async (req, ctx) => {
  const input = schema.parse(await body(req));
  const result = await runScannerBacktest(ctx.userId, input);
  return { ok: true, ...result };
});
