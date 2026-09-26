import { api } from "@/infrastructure/http/api";
import { redis, redisPing, SYSTEM_LOG_KEY } from "@/infrastructure/redis/client";

export const GET = api(async (req) => {
  if (!(await redisPing(2000))) return { logs: [] };
  const n = Math.min(Number(new URL(req.url).searchParams.get("n") ?? "400") || 400, 1000);
  const lines = await redis.lrange(SYSTEM_LOG_KEY, -n, -1);
  const logs = lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { logs };
}, { admin: true });
