import { api } from "@/infrastructure/http/api";
import { getOrCreateConfig } from "@/modules/signal-factory/config";
import { jobRun } from "@/modules/signal-factory/jobs";
import { scanUser } from "@/modules/signal-factory/setups";

/** POST /api/signal-factory/scan — run the market scan now for this user.
 *  Idempotent: goes through jobRun (registry-tracked) and scanUser refreshes
 *  existing active setups in place rather than duplicating them. */
export const POST = api(async (_req, ctx) => {
  const cfg = await getOrCreateConfig(ctx.userId);
  const result = await jobRun(
    "market-scan",
    `${cfg.scanEveryHours}h`,
    () => scanUser(ctx.userId),
    { userId: ctx.userId, kind: "BULLMQ" },
  );
  if (result === undefined) {
    return { ok: false, disabled: true, error: "job اسکن پس از خطاهای پیاپی غیرفعال است" };
  }
  return { ok: true, result };
});
