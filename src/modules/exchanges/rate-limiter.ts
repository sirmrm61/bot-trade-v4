import { redis } from "@/infrastructure/redis/client";
import { sleep } from "@/shared/utils";
import { AppError } from "@/shared/errors";

/**
 * Multi-scope sliding-window rate limiter backed by Redis.
 *
 * Scopes: per exchange, per user, per worker, per endpoint.
 * Nobitex real limits:
 *   - order placement: 300 orders / 10 min (shared spot+margin+batch)
 *   - order status update: 90 req / min
 *   - general API: conservative defaults below
 *
 * If Redis is unavailable we degrade to an in-process map so local dev
 * without Docker still works.
 */

interface LimitRule {
  limit: number;
  windowMs: number;
}

const RULES: Record<string, LimitRule> = {
  "endpoint:/market/orders/add": { limit: 300, windowMs: 10 * 60_000 },
  "endpoint:/market/orders/update-status": { limit: 90, windowMs: 60_000 },
  "endpoint:/market/orders/batch-add": { limit: 300, windowMs: 10 * 60_000 },
  "exchange:nobitex": { limit: 240, windowMs: 60_000 }, // ~4 rps sustained
  user: { limit: 60, windowMs: 60_000 },
  worker: { limit: 120, windowMs: 60_000 },
  default: { limit: 60, windowMs: 60_000 },
};

const localBuckets = new Map<string, number[]>();

function localAcquire(key: string, rule: LimitRule): boolean {
  const now = Date.now();
  const arr = (localBuckets.get(key) ?? []).filter((t) => now - t < rule.windowMs);
  if (arr.length >= rule.limit) {
    localBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  localBuckets.set(key, arr);
  return true;
}

async function redisAcquire(key: string, rule: LimitRule): Promise<boolean> {
  const now = Date.now();
  const redisKey = `rl:${key}`;
  try {
    const res = await redis
      .multi()
      .zremrangebyscore(redisKey, 0, now - rule.windowMs)
      .zadd(redisKey, now, `${now}:${Math.random()}`)
      .zcard(redisKey)
      .pexpire(redisKey, rule.windowMs)
      .exec();
    const count = (res?.[2]?.[1] as number) ?? 0;
    if (count > rule.limit) {
      await redis.zrem(redisKey, `${now}`).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return localAcquire(key, rule);
  }
}

async function acquire(key: string, rule: LimitRule): Promise<boolean> {
  try {
    if (redis.status === "ready" || redis.status === "connecting") {
      // maxRetriesPerRequest:null buffers commands forever on a dead Redis —
      // race a timeout so a hung connection degrades to local buckets
      return await Promise.race([
        redisAcquire(key, rule),
        new Promise<boolean>((res) => setTimeout(() => res(localAcquire(key, rule)), 2_000)),
      ]);
    }
  } catch {
    /* fall through */
  }
  return localAcquire(key, rule);
}

export interface RateLimitScope {
  exchange?: string;
  endpoint?: string;
  userId?: string;
  workerId?: string;
}

/**
 * Acquire capacity across all relevant scopes. Retries with
 * backoff + jitter until a slot frees up or maxWait is exceeded.
 */
export async function rateLimit(
  scope: RateLimitScope,
  opts: { maxWaitMs?: number } = {},
): Promise<void> {
  const maxWait = opts.maxWaitMs ?? 30_000;
  const start = Date.now();
  const checks: [string, LimitRule][] = [];

  if (scope.endpoint) {
    const key = `endpoint:${scope.endpoint}`;
    checks.push([key, RULES[key] ?? RULES.default]);
  }
  if (scope.exchange) {
    const key = `exchange:${scope.exchange}`;
    checks.push([key, RULES[key] ?? RULES.default]);
  }
  if (scope.userId) checks.push([`user:${scope.userId}`, RULES.user]);
  if (scope.workerId) checks.push([`worker:${scope.workerId}`, RULES.worker]);

  let attempt = 0;
  while (true) {
    let ok = true;
    for (const [key, rule] of checks) {
      if (!(await acquire(key, rule))) {
        ok = false;
        break;
      }
    }
    if (ok) return;
    if (Date.now() - start > maxWait) {
      throw new AppError("NOBITEX_RATE_LIMITED", 429);
    }
    attempt++;
    const backoff = Math.min(500 * 2 ** attempt, 8_000);
    await sleep(backoff + Math.random() * 250); // jitter
  }
}
