import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { syncPairs } from "@/modules/pairs/service";

export const GET = api(async () => {
  const pairs = await prisma.pair.findMany({ orderBy: { symbol: "asc" } });
  return { pairs };
}, { admin: true });

export const POST = api(async () => {
  const result = await syncPairs();
  return { ok: true, ...result };
}, { admin: true });

const patchSchema = z.object({ pairId: z.string(), active: z.boolean() });
export const PATCH = api(async (req) => {
  const { pairId, active } = patchSchema.parse(await body(req));
  await prisma.pair.update({ where: { id: pairId }, data: { active, tradingStatus: active ? "ACTIVE" : "DISABLED" } });
  return { ok: true };
}, { admin: true });
