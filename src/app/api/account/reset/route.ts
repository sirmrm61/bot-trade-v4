import { api, body } from "@/infrastructure/http/api";
import { AppError } from "@/shared/errors";
import { resetTestData } from "@/modules/account/reset";

/**
 * Reset test data — deletes all paper lives, backtests, test trade history,
 * scanner/whale artifacts and unused strategies. REAL trading data is kept.
 * Requires an explicit confirmation token so it can't fire accidentally.
 */
export const POST = api(async (req, ctx) => {
  const { confirm } = await body<{ confirm?: string }>(req);
  if (confirm !== "RESET") throw new AppError("VALIDATION", 400);
  const summary = await resetTestData(ctx.userId);
  return { ok: true, summary };
});
