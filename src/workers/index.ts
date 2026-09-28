import "dotenv/config";
import { Worker, type Job } from "bullmq";
import {
  createRedisConnection,
  redis,
  WORKER_HEARTBEAT_KEY,
  WORKER_INFO_KEY,
  WORKER_SHUTDOWN_KEY,
} from "@/infrastructure/redis/client";
import { QUEUE_NAMES } from "@/infrastructure/queue/queues";
import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { executeBacktest } from "@/modules/backtest/service";
import { liveTick } from "@/modules/trading/live-engine";
import { submitOrder, monitorOrder } from "@/modules/trading/order-engine";
import { syncPairs } from "@/modules/pairs/service";
import { EXCHANGE_IDS } from "@/shared/constants";
import { reconcileAll, recoverOnStartup } from "@/modules/trading/reconciliation";
import { sweepExpirations } from "@/modules/subscriptions/service";
import { sendTelegram } from "@/modules/notifications/service";
import { markApiConnected, markFirstLiveTrade } from "@/modules/referrals/service";
import { getSetting } from "@/modules/settings/service";

/**
 * Worker process — runs outside Next.js request/response cycle.
 * Restart-safe: BullMQ re-queues stalled jobs; recoverOnStartup()
 * reconciles internal state with the exchange on boot.
 */

const WORKER_ID = `worker-${process.pid}`;
const workers: Worker[] = [];

async function gracefulShutdown() {
  logger.info("worker shutdown requested", { module: "worker", workerId: WORKER_ID });
  await redis.del(WORKER_SHUTDOWN_KEY, WORKER_HEARTBEAT_KEY).catch(() => {});
  await redis
    .set(
      WORKER_INFO_KEY,
      JSON.stringify({ workerId: WORKER_ID, pid: process.pid, stoppedAt: new Date().toISOString() }),
    )
    .catch(() => {});
  await Promise.race([
    Promise.all(workers.map((w) => w.close())),
    new Promise((r) => setTimeout(r, 5000)),
  ]).catch(() => {});
  process.exit(0);
}

async function main() {
  logger.info("worker starting", { module: "worker", workerId: WORKER_ID });

  await redis
    .set(
      WORKER_INFO_KEY,
      JSON.stringify({ workerId: WORKER_ID, pid: process.pid, startedAt: new Date().toISOString() }),
    )
    .catch(() => {});

  // 1. recovery — reconcile before resuming
  await recoverOnStartup().catch((e) => logger.error("recovery failed", { errorCode: String(e) }));

  const conn = () => createRedisConnection();

  // attach error handler so a dropped Redis connection doesn't crash the process
  const mkWorker = (
    name: string,
    processor: (job: Job) => Promise<void>,
    opts: { concurrency?: number } = {},
  ) => {
    const w = new Worker(name, processor, { connection: conn(), ...opts });
    w.on("error", (e) =>
      logger.warn("queue worker error", { module: "worker", queue: name, errorCode: String(e).slice(0, 120) }),
    );
    workers.push(w);
    return w;
  };

  // 2. backtest queue
  mkWorker(
    QUEUE_NAMES.BACKTEST,
    async (job: Job) => {
      const { backtestId } = job.data as { backtestId: string };
      await executeBacktest(backtestId);
    },
    { concurrency: 2 },
  );

  // 3. live strategy queue — tick every strategy cycle
  mkWorker(
    QUEUE_NAMES.LIVE_STRATEGY,
    async (job: Job) => {
      const data = job.data as { liveStrategyId: string; action: string };
      if (data.action === "TICK" || data.action === "START") {
        await liveTick(data.liveStrategyId);
      }
      // PAUSE/STOP are handled by DB status — tick picks them up
    },
    { concurrency: 4 },
  );

  // 4. order queue
  mkWorker(
    QUEUE_NAMES.ORDER,
    async (job: Job) => {
      const { orderId, action } = job.data as { orderId: string; action: string };
      if (action === "SUBMIT") await submitOrder(orderId);
      else if (action === "MONITOR") await monitorOrder(orderId);
    },
    { concurrency: 4 },
  );

  // 5. market data (pair sync, candle fetch)
  mkWorker(
    QUEUE_NAMES.MARKET_DATA,
    async (job: Job) => {
      const data = job.data as { type: string };
      if (data.type === "SYNC_PAIRS") {
        // sync every exchange that has an adapter — failures are isolated per exchange
        for (const ex of EXCHANGE_IDS) {
          await syncPairs(ex).catch((e) =>
            logger.warn("pair sync failed", { module: "pairs", exchange: ex, error: String(e) }));
        }
      }
    },
    {},
  );

  // 6. reconciliation
  mkWorker(
    QUEUE_NAMES.RECONCILIATION,
    async () => {
      await reconcileAll();
    },
    {},
  );

  // 7. notifications — telegram relay (isolated so it can't block trading)
  mkWorker(
    QUEUE_NAMES.NOTIFICATION,
    async (job: Job) => {
      const { notificationId } = job.data as { notificationId?: string };
      if (!notificationId) return;
      const n = await prisma.notification.findUnique({
        where: { id: notificationId },
        include: { user: { select: { telegramChatId: true } } },
      });
      if (!n || !n.user?.telegramChatId || n.telegramSent) return;
      const sent = await sendTelegram(n.user.telegramChatId, `<b>${n.title}</b>\n${n.body}`);
      if (sent) {
        await prisma.notification.update({ where: { id: n.id }, data: { telegramSent: true } });
      }
    },
    {},
  );

  // 8. subscription sweeper
  mkWorker(
    QUEUE_NAMES.SUBSCRIPTION,
    async () => {
      const r = await sweepExpirations();
      if (r.expired || r.restricted) logger.info("subscription sweep", { module: "subscriptions", ...r });
    },
    {},
  );

  // 9. referrals
  mkWorker(
    QUEUE_NAMES.REFERRAL,
    async (job: Job) => {
      const { referralId, check } = job.data as { referralId: string; check: string };
      const ref = await prisma.referral.findUnique({ where: { id: referralId } });
      if (!ref) return;
      if (check === "API_CONNECTED") await markApiConnected(ref.refereeId);
      if (check === "FIRST_LIVE_TRADE") await markFirstLiveTrade(ref.refereeId);
    },
    {},
  );

  // 10. cleanup
  mkWorker(
    QUEUE_NAMES.CLEANUP,
    async (job: Job) => {
      const { type } = job.data as { type: string };
      if (type === "EXPIRED_SESSIONS") {
        await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] } });
      }
      if (type === "OLD_CANDLES") {
        await prisma.historicalCandle.deleteMany({ where: { time: { lt: new Date(Date.now() - 90 * 86_400_000) } } });
      }
    },
    {},
  );

  // ---- schedulers --------------------------------------------------------
  const tickSec = await getSetting<number>("LIVE_TICK_SEC").catch(() => 20);
  const { getQueue } = await import("@/infrastructure/queue/queues");

  // live ticks — every tickSec, enqueue a tick per running strategy
  setInterval(async () => {
    try {
      // admin-requested full stop — drain consumers and exit
      if (await redis.get(WORKER_SHUTDOWN_KEY)) {
        await gracefulShutdown();
        return;
      }
      const running = await prisma.liveStrategy.findMany({
        where: { status: { in: ["RUNNING", "STARTING", "PAUSED", "DEGRADED", "STOPPING"] } },
        select: { id: true },
      });
      for (const s of running) {
        // jobId dedupes in-flight ticks; removeOnFail:true is critical — a failed
        // job keeps its id, and BullMQ would silently drop every future add()
        // for it (observed: SQLITE_FULL during deploy poisoned stop policies).
        await getQueue(QUEUE_NAMES.LIVE_STRATEGY).add(
          "tick",
          { liveStrategyId: s.id, action: "TICK" },
          {
            jobId: `tick-${s.id}`,
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 3,
            backoff: { type: "fixed", delay: 5000 },
          },
        );
      }
      await redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()));
    } catch (e) {
      logger.warn("tick scheduler error", { errorCode: String(e) });
    }
  }, tickSec * 1000);

  // cron-style repeatables via BullMQ job schedulers — retry until Redis is up
  const repeatable = async (queue: string, name: string, data: object, everyMs: number) => {
    await getQueue(queue as never).upsertJobScheduler(`cron:${name}`, { every: everyMs }, { name, data });
  };
  const registerSchedulers = async () => {
    await repeatable(QUEUE_NAMES.MARKET_DATA, "sync-pairs", { type: "SYNC_PAIRS" }, 10 * 60_000);
    await repeatable(QUEUE_NAMES.RECONCILIATION, "reconcile", {}, 60_000);
    await repeatable(QUEUE_NAMES.SUBSCRIPTION, "sweep", { type: "CHECK_EXPIRY" }, 5 * 60_000);
    await repeatable(QUEUE_NAMES.CLEANUP, "cleanup-sessions", { type: "EXPIRED_SESSIONS" }, 6 * 3_600_000);
    await repeatable(QUEUE_NAMES.CLEANUP, "cleanup-candles", { type: "OLD_CANDLES" }, 24 * 3_600_000);
    await redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()));
  };
  const tryRegister = async () => {
    try {
      await registerSchedulers();
      logger.info("worker ready — all queues listening", { module: "worker", workerId: WORKER_ID });
    } catch (e) {
      logger.warn("scheduler registration failed (redis down?) — retrying in 5s", {
        module: "worker", errorCode: String(e).slice(0, 120),
      });
      setTimeout(tryRegister, 5000);
    }
  };
  await tryRegister();
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((e) => {
  logger.error("worker fatal", { errorCode: String(e) });
  process.exit(1);
});
