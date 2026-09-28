import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { syncPairs } from "@/modules/pairs/service";
import { EXCHANGE_IDS } from "@/shared/constants";

export const GET = api(async () => {
  const pairs = await prisma.pair.findMany({ orderBy: { symbol: "asc" } });
  return { pairs };
}, { admin: true });

export const POST = api(async (req) => {
  const exchange = new URL(req.url).searchParams.get("exchange")?.toUpperCase();
  if (exchange) {
    const result = await syncPairs(exchange);
    return { ok: true, exchange, ...result };
  }
  const results: Record<string, unknown> = {};
  for (const ex of EXCHANGE_IDS) {
    results[ex] = await syncPairs(ex).catch((e) => ({ error: String(e) }));
  }
  return { ok: true, results };
}, { admin: true });

const patchSchema = z.object({ pairId: z.string(), active: z.boolean() });
export const PATCH = api(async (req) => {
  const { pairId, active } = patchSchema.parse(await body(req));
  await prisma.pair.update({ where: { id: pairId }, data: { active, tradingStatus: active ? "ACTIVE" : "DISABLED" } });
  return { ok: true };
}, { admin: true });
