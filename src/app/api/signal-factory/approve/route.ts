import { api, body } from "@/infrastructure/http/api";
import { AppError } from "@/shared/errors";
import { approveLive } from "@/modules/signal-factory/live";

/** POST /api/signal-factory/approve {typeKey} — explicit user promotion of a
 *  SetupType to LIVE_SMALL (25% size). The FULL checklist must pass — no
 *  partial credit; a failure lists the missing conditions in `detail`. */
export const POST = api(async (req, ctx) => {
  const { typeKey } = await body<{ typeKey?: string }>(req);
  if (typeof typeKey !== "string" || !typeKey.trim()) {
    throw new AppError("VALIDATION", 400, { typeKey });
  }
  const type = await approveLive(typeKey, ctx.userId);
  return {
    ok: true,
    typeKey: type.key,
    liveApproved: type.liveApproved,
    liveSizeScale: type.liveSizeScale,
  };
});
