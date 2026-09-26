import Redis from "ioredis";
import { setLogSink } from "@/infrastructure/logging/logger";

const globalForRedis = globalThis as unknown as { redis?: Redis };

/** Redis keys shared between the worker process and the admin control plane. */
export const WORKER_HEARTBEAT_KEY = "worker:heartbeat";
export const WORKER_INFO_KEY = "worker:info";
export const WORKER_SHUTDOWN_KEY = "worker:control:shutdown";
export const SYSTEM_LOG_KEY = "system:logs";
const SYSTEM_LOG_MAX = 2000;

export function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL;
  const opts = url
    ? url
    : {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
      };
  // maxRetriesPerRequest: null is required by BullMQ
  const conn = new Redis(opts as never, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  // swallow connection errors — retryStrategy keeps reconnecting; callers use redisPing()
  conn.on("error", () => {});
  return conn;
}

export const redis =
  globalForRedis.redis ?? (globalForRedis.redis = createRedisConnection());

// Mirror every log line into a bounded Redis list so the admin panel can read
// both web-app and worker logs. Skipped while the connection is down — the
// offline queue would otherwise buffer log writes indefinitely.
setLogSink((line) => {
  if (redis.status !== "ready") return;
  void redis
    .pipeline()
    .rpush(SYSTEM_LOG_KEY, line)
    .ltrim(SYSTEM_LOG_KEY, -SYSTEM_LOG_MAX, -1)
    .exec()
    .catch(() => {});
});

/** In-memory fallback used when Redis is unavailable (dev without docker). */
export async function redisPing(timeoutMs = 3000): Promise<boolean> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timeout")), timeoutMs),
    );
    return (await Promise.race([redis.ping(), timeout])) === "PONG";
  } catch {
    return false;
  }
}
