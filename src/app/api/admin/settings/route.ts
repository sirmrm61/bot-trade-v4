import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { allSettings, setSetting } from "@/modules/settings/service";
import { logActivity } from "@/modules/activity/service";

export const GET = api(async () => {
  return { settings: await allSettings() };
}, { admin: true });

const schema = z.object({ key: z.string(), value: z.unknown() });

export const POST = api(async (req, ctx) => {
  const { key, value } = schema.parse(await body(req));
  await setSetting(key, value, ctx.userId);
  await logActivity({
    userId: ctx.userId, actorType: "ADMIN", action: "ADMIN_UPDATE_SETTING",
    entityType: "setting", entityId: key, metadata: { key },
  });
  return { ok: true };
}, { admin: true });
