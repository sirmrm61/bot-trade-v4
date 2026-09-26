import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/database/prisma";
import { redisPing } from "@/infrastructure/redis/client";
import { publicAdapter } from "@/modules/exchanges/registry";
import { getQueue, QUEUE_NAMES } from "@/infrastructure/queue/queues";

/** Health probes: /api/health/database|redis|worker|nobitex|queues */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ check: string }> },
) {
  const { check } = await ctx.params;
  let ok = false;
  let detail: unknown = null;

  switch (check) {
    case "database":
      try {
        await prisma.user.count();
        ok = true;
      } catch (e) { detail = String(e); }
      break;
    case "redis":
      ok = await redisPing();
      break;
    case "nobitex":
      try {
        const t = await publicAdapter().getTicker("BTCIRT");
        ok = t.last > 0;
      } catch (e) { detail = String(e); }
      break;
    case "queues":
      try {
        const counts: Record<string, unknown> = {};
        for (const name of Object.values(QUEUE_NAMES)) {
          const c = await getQueue(name).getJobCounts();
          counts[name] = c;
        }
        ok = true;
        detail = counts;
      } catch (e) { detail = String(e); }
      break;
    case "worker":
      // worker writes a heartbeat key to redis every cycle
      try {
        const { redis } = await import("@/infrastructure/redis/client");
        const hb = await redis.get("worker:heartbeat");
        ok = !!hb && Date.now() - Number(hb) < 120_000;
        detail = { lastHeartbeat: hb ? new Date(Number(hb)).toISOString() : null };
      } catch (e) { detail = String(e); }
      break;
    default:
      return NextResponse.json({ ok: false, error: "unknown check" }, { status: 404 });
  }
  return NextResponse.json({ ok, check, detail }, { status: ok ? 200 : 503 });
}
