import { api } from "@/infrastructure/http/api";
import { AppError } from "@/shared/errors";
import { traceTrade } from "@/modules/trace/service";

/**
 * GET /api/trace/:tradeTraceId — the headline debugging API: the whole
 * decision chain of one trade, from market data to net PnL.
 */
export const GET = api(async (_req, ctx) => {
  const id = ctx.params?.id;
  if (!id) throw new AppError("NOT_FOUND", 404);
  return traceTrade(ctx.userId, id);
});
