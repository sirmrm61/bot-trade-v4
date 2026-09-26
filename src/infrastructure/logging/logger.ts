/**
 * Structured JSON logger.
 * Secrets / API credentials must NEVER be logged — use sanitize() helpers.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  userId?: string;
  module?: string;
  action?: string;
  duration?: number;
  status?: string | number;
  errorCode?: string;
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

/** Which process emitted the log — distinguishes worker output from the web app in the admin log viewer. */
const PROC =
  process.env.PROC_NAME ??
  (/workers[\/\\]index\.[tj]s$/.test(process.argv[1] ?? "") ? "worker" : "app");

type LogSink = (line: string) => void;
let sink: LogSink | null = null;
/** Optional extra destination for every log line (e.g. a Redis list for the admin panel). */
export function setLogSink(fn: LogSink) {
  sink = fn;
}

const SECRET_KEYS = new Set([
  "password", "passwordhash", "secret", "apisecret", "apikey", "apikeyenc",
  "apisecretenc", "token", "authorization", "totpsecret", "encryptionkey",
]);

/** Deep-sanitize an object before logging — strips any secret-bearing key. */
export function sanitize<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitize) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : sanitize(v);
  }
  return out as T;
}

function write(level: LogLevel, message: string, context?: LogContext) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    proc: PROC,
    msg: message,
    ...(context ? sanitize(context) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  try {
    sink?.(line);
  } catch { /* sink failures must never break logging */ }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => write("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => write("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => write("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => write("error", msg, ctx),
};

/** Wrap an async operation with duration + status logging. */
export async function logged<T>(
  ctx: LogContext,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logger.info(ctx.action ?? "op", { ...ctx, duration: Date.now() - start, status: "OK" });
    return result;
  } catch (err) {
    logger.error(ctx.action ?? "op", {
      ...ctx,
      duration: Date.now() - start,
      status: "ERROR",
      errorCode: err instanceof Error ? err.message : "UNKNOWN",
    });
    throw err;
  }
}
