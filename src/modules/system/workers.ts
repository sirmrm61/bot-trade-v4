import { getQueue, QUEUE_NAMES, type QueueName } from "@/infrastructure/queue/queues";
import {
  redis,
  redisPing,
  WORKER_HEARTBEAT_KEY,
  WORKER_INFO_KEY,
  WORKER_SHUTDOWN_KEY,
} from "@/infrastructure/redis/client";
import { AppError } from "@/shared/errors";
import { spawn } from "node:child_process";

/**
 * Worker control plane for the admin panel.
 * Status: BullMQ queue metrics + worker heartbeat.
 * Control: queue.pause()/resume()/drain() (global, Redis-backed — the worker
 * process picks it up), a shutdown flag the worker polls each tick, and a
 * best-effort local spawn for bringing a dead worker back up.
 */

export const WORKER_QUEUE_META: { name: QueueName; label: string }[] = [
  { name: QUEUE_NAMES.LIVE_STRATEGY, label: "استراتژی‌های زنده" },
  { name: QUEUE_NAMES.ORDER, label: "سفارش‌ها" },
  { name: QUEUE_NAMES.BACKTEST, label: "بک‌تست" },
  { name: QUEUE_NAMES.MARKET_DATA, label: "داده بازار" },
  { name: QUEUE_NAMES.RECONCILIATION, label: "تطبیق سفارش‌ها" },
  { name: QUEUE_NAMES.NOTIFICATION, label: "اعلان‌ها" },
  { name: QUEUE_NAMES.SUBSCRIPTION, label: "اشتراک‌ها" },
  { name: QUEUE_NAMES.REFERRAL, label: "رفرال" },
  { name: QUEUE_NAMES.CLEANUP, label: "پاک‌سازی" },
];

const VALID_QUEUES = new Set<string>(Object.values(QUEUE_NAMES));
/** Heartbeat older than this ⇒ worker process considered dead. */
const ALIVE_MS = 90_000;

export interface WorkerQueueStatus {
  name: QueueName;
  label: string;
  paused: boolean;
  counts: Record<string, number>;
}

export interface WorkerProcessInfo {
  workerId?: string;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
}

export async function getWorkerStatus() {
  if (!(await redisPing(2000))) {
    return { redis: false as const, process: { alive: false }, queues: [] as WorkerQueueStatus[] };
  }
  const [hb, infoRaw] = await Promise.all([
    redis.get(WORKER_HEARTBEAT_KEY),
    redis.get(WORKER_INFO_KEY),
  ]);
  const heartbeatAt = hb ? Number(hb) : null;
  let info: WorkerProcessInfo | null = null;
  try {
    info = infoRaw ? (JSON.parse(infoRaw) as WorkerProcessInfo) : null;
  } catch { info = null; }

  const queues = await Promise.all(
    WORKER_QUEUE_META.map(async (m) => {
      const q = getQueue(m.name);
      const [paused, counts] = await Promise.all([
        q.isPaused(),
        q.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
      ]);
      return { name: m.name, label: m.label, paused, counts };
    }),
  );

  return {
    redis: true as const,
    process: {
      alive: heartbeatAt !== null && Date.now() - heartbeatAt < ALIVE_MS,
      heartbeatAt,
      info,
    },
    queues,
  };
}

export type WorkerAction =
  | "pause" | "resume" | "drain"
  | "pause-all" | "resume-all"
  | "shutdown" | "start";

const ALL_ACTIONS = new Set<string>([
  "pause", "resume", "drain", "pause-all", "resume-all", "shutdown", "start",
]);

export async function runWorkerAction(action: string, queue?: string) {
  if (!ALL_ACTIONS.has(action)) throw new AppError("VALIDATION");
  const q = queue && VALID_QUEUES.has(queue) ? (queue as QueueName) : null;

  switch (action as WorkerAction) {
    case "pause":
    case "resume":
    case "drain": {
      if (!q) throw new AppError("VALIDATION");
      const target = getQueue(q);
      if (action === "pause") await target.pause();
      else if (action === "resume") await target.resume();
      else await target.drain();
      break;
    }
    case "pause-all":
    case "resume-all":
      for (const name of Object.values(QUEUE_NAMES)) {
        const target = getQueue(name);
        if (action === "pause-all") await target.pause();
        else await target.resume();
      }
      break;
    case "shutdown":
      // the worker's tick loop polls this flag and exits gracefully
      await redis.set(WORKER_SHUTDOWN_KEY, "1");
      break;
    case "start": {
      const status = await getWorkerStatus();
      if (status.process.alive) throw new AppError("DUPLICATE_OPERATION");
      // best-effort local spawn — works when the web app and worker share a host
      spawn("npm run worker", {
        cwd: process.cwd(),
        shell: true,
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      }).unref();
      break;
    }
  }
}
