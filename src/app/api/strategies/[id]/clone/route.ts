import { api, body } from "@/infrastructure/http/api";
import { cloneStrategy } from "@/modules/strategies/service";

export const POST = api(async (req, ctx) => {
  const { versionId, name } = (await body(req)) as { versionId: string; name?: string };
  const result = await cloneStrategy({ userId: ctx.userId, sourceVersionId: versionId, name });
  return { ok: true, strategy: result.strategy };
});
