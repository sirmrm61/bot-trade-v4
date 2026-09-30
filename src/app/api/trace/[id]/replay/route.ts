import { api } from "@/infrastructure/http/api";
import { AppError } from "@/shared/errors";
import { replayTrade } from "@/modules/trace/service";

/**
 * POST /api/trace/:tradeTraceId/replay — deterministic re-simulation of one
 * trade; returns REPLAY_MATCH or REPLAY_MISMATCH with per-field diffs.
 */
export const POST = api(async (_req, ctx) => {
  const id = ctx.params?.id;
  if (!id) throw new AppError("NOT_FOUND", 404);
  return replayTrade(ctx.userId, id);
});
