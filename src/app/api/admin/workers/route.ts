import { api, body } from "@/infrastructure/http/api";
import { getWorkerStatus, runWorkerAction } from "@/modules/system/workers";
import { logActivity } from "@/modules/activity/service";

export const GET = api(async () => getWorkerStatus(), { admin: true });

export const POST = api(async (req, ctx) => {
  const { action, queue } = await body<{ action: string; queue?: string }>(req);
  await runWorkerAction(action, queue);
  await logActivity({
    userId: ctx.userId,
    actorType: "ADMIN",
    action: "WORKER_CONTROL",
    entityType: "worker",
    entityId: queue ?? "process",
    metadata: { action },
  });
  return { ok: true };
}, { admin: true });
