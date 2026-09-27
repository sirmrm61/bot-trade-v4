import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { marketStats, suggestParams } from "@/modules/strategies/suggest";
import { AppError } from "@/shared/errors";
import { STRATEGY_KINDS } from "@/shared/constants";

const schema = z.object({
  symbol: z.string().min(2),
  timeframe: z.string(),
  kind: z.string(),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

/** Market-aware parameter suggestion — analyzes recent candles for the pair. */
export const POST = api(async (req, ctx) => {
  void ctx;
  const input = schema.parse(await body(req));
  if (!STRATEGY_KINDS.includes(input.kind as never)) {
    throw new AppError("VALIDATION", 400, { field: "kind" });
  }
  const tf = tfMs(input.timeframe);
  const count = 400;
  const end = new Date();
  const start = new Date(end.getTime() - count * tf);
  const candles = await getCandles({ symbol: input.symbol, timeframe: input.timeframe, start, end });
  if (candles.length < 60) throw new AppError("INSUFFICIENT_DATA", 422, { candles: candles.length });
  const stats = marketStats(candles);
  const { fields, notes } = suggestParams(input.kind, input.risk, stats);
  return { ok: true, fields, notes, stats };
});
