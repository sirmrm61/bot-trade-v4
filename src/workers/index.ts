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

  // 10. cleanup — sessions, candles, rotated logs, disk watchdog, sqlite vacuum
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
      if (type === "OLD_LOGS") {
        // 30-day retention for chatty tables — SignalLog is the ML dataset
        // so it keeps a longer horizon
        const month = new Date(Date.now() - 30 * 86_400_000);
        const quarter = new Date(Date.now() - 90 * 86_400_000);
        const [a, b, c, d] = await Promise.all([
          prisma.tradingAgentLog.deleteMany({ where: { createdAt: { lt: month } } }),
          prisma.agentJournal.deleteMany({ where: { createdAt: { lt: quarter } } }),
          prisma.signalLog.deleteMany({ where: { createdAt: { lt: quarter } } }),
          prisma.notification.deleteMany({ where: { createdAt: { lt: month } } }),
        ]);
        const n = a.count + b.count + c.count + d.count;
        if (n > 0) logger.info("log rotation", { module: "worker", deleted: n });
      }
      if (type === "SQLITE_VACUUM") {
        await prisma.$executeRawUnsafe("VACUUM").catch((e) =>
          logger.warn("sqlite vacuum failed", { module: "worker", error: String(e).slice(0, 120) }));
      }
      if (type === "DISK_CHECK") {
        try {
          const { statfsSync } = await import("node:fs");
          const s = statfsSync(process.cwd());
          const usedPct = 100 * (1 - s.bavail / s.blocks);
          if (usedPct > 85) {
            const flag = await redis.set("disk:warn", "1", "EX", 86_400, "NX");
            if (flag) {
              const { notify } = await import("@/modules/notifications/service");
              const owners = await prisma.tradingAgent.findMany({
                where: { status: "RUNNING" }, select: { userId: true }, distinct: ["userId"],
              });
              for (const o of owners) {
                await notify({
                  userId: o.userId, type: "SYSTEM", severity: "WARNING",
                  title: "هشدار فضای دیسک",
                  body: `مصرف دیسک سرور به ${usedPct.toFixed(0)}٪ رسیده است — پاک‌سازی لازم است.`,
                });
              }
            }
            logger.warn("disk usage high", { module: "worker", usedPct: usedPct.toFixed(1) });
          }
        } catch { /* statfs unsupported — skip */ }
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
        select: { id: true, status: true },
      });
      for (const s of running) {
        // DEGRADED strategies retry every 5 min, not every tick — a permanently
        // broken venue otherwise gets hammered and floods the logs
        if (s.status === "DEGRADED") {
          const probe = await redis.set(`degraded:tick:${s.id}`, "1", "EX", 300, "NX");
          if (!probe) continue;
        }
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

  // trading agents — every 60s, run reviews for agents whose interval elapsed.
  // agentTick holds a Redis lock so a long CLI run can't overlap itself.
  setInterval(async () => {
    try {
      const { runAgentCycle } = await import("@/modules/agent/service");
      const n = await runAgentCycle();
      if (n > 0) logger.info("agent cycle", { module: "agent", due: n });
    } catch (e) {
      logger.warn("agent scheduler error", { module: "agent", errorCode: String(e).slice(0, 120) });
    }
  }, 60_000);

  // live-tick watchdog — every 2 min: a RUNNING/STARTING live whose
  // lastSignalAt is older than ~3 tick cycles is stale (missed jobs, poisoned
  // jobId, queue stall). Log it, record an incident, force a tick now.
  setInterval(async () => {
    try {
      const stale = await prisma.liveStrategy.findMany({
        where: {
          status: { in: ["RUNNING", "STARTING"] },
          OR: [
            { lastSignalAt: { lt: new Date(Date.now() - 3 * tickSec * 1000) } },
            { lastSignalAt: null, startedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
        select: { id: true, symbol: true, userId: true, circuitBreakerFailures: true, lastSignalAt: true },
      });
      for (const s of stale) {
        logger.warn("live tick watchdog — stale strategy", {
          module: "worker", liveStrategyId: s.id, symbol: s.symbol,
          lastSignalAt: s.lastSignalAt?.toISOString() ?? null,
        });
        // agent-managed? record a journal incident the CLI will see
        const agent = await prisma.tradingAgent.findFirst({
          where: { managed: { contains: s.id }, status: "RUNNING" }, select: { id: true },
        });
        if (agent) {
          const { journalWrite } = await import("@/modules/agent/journal");
          await journalWrite(agent.id, "INCIDENT",
            `تیک استراتژی ${s.symbol} بیش از ${Math.round(3 * tickSec)} ثانیه اجرا نشد — ریکاوری خودکار`,
            { data: { liveStrategyId: s.id, lastSignalAt: s.lastSignalAt } });
        }
        // recovery: clear the failure counter and enqueue a fresh tick —
        // removeOnFail:true on the job means a stuck jobId can't block it
        await prisma.liveStrategy.update({
          where: { id: s.id }, data: { circuitBreakerFailures: 0 },
        }).catch(() => {});
        await getQueue(QUEUE_NAMES.LIVE_STRATEGY).add(
          "tick", { liveStrategyId: s.id, action: "TICK" },
          { jobId: `watchdog-${s.id}-${Date.now()}`, removeOnComplete: true, removeOnFail: true },
        ).catch(() => {});
      }
    } catch (e) {
      logger.warn("watchdog error", { module: "worker", errorCode: String(e).slice(0, 120) });
    }
  }, 120_000);

  // self-improvement loop — every 30 min. Internally rate-limited to one
  // hypothesis per strategy per 6h and gated on ≥10 fresh closed trades.
  setInterval(async () => {
    try {
      const { runImprovementCycle } = await import("@/modules/agent/improve");
      await runImprovementCycle();
    } catch (e) {
      logger.warn("improvement cycle error", { module: "improve", errorCode: String(e).slice(0, 120) });
    }
  }, 30 * 60_000);

  // forecast layer — every 15 min: record predictions for managed pairs and
  // resolve the ones whose horizon elapsed (feeds the live-accuracy monitor)
  setInterval(async () => {
    try {
      const fc = await import("@/modules/forecast/service");
      const n = await fc.recordPredictions();
      const r = await fc.resolvePredictions();
      if (n || r) logger.info("forecast cycle", { module: "forecast", recorded: n, resolved: r });
    } catch (e) {
      logger.warn("forecast cycle error", { module: "forecast", errorCode: String(e).slice(0, 120) });
    }
  }, 15 * 60_000);

  // forecast maintenance — every 6h: live-accuracy monitor (2 bad days →
  // deactivate) + daily retrain check. retrainModels is itself the gatekeeper:
  // a version activates only when it beats the baseline out-of-sample.
  setInterval(async () => {
    try {
      const fc = await import("@/modules/forecast/service");
      await fc.checkLiveAccuracy();
      const key = `forecast:retrain:${new Date().toISOString().slice(0, 10)}`;
      if (await redis.set(key, "1", "EX", 86_400, "NX")) {
        const reports = await fc.retrainModels();
        logger.info("forecast retrain done", {
          module: "forecast",
          models: reports.length,
          activated: reports.filter((r) => r.activated).length,
        });
      }
    } catch (e) {
      logger.warn("forecast retrain error", { module: "forecast", errorCode: String(e).slice(0, 120) });
    }
  }, 6 * 3_600_000);

  // daily plan — every 5 min refresh each running agent's state machine
  // (catches transitions even when no entry is attempted); once after UTC
  // midnight write yesterday's closing summary to the journal.
  setInterval(async () => {
    try {
      const { refreshDailyPlan, closeDailyPlan } = await import("@/modules/trading/daily-plan");
      const agents = await prisma.tradingAgent.findMany({
        where: { status: { in: ["RUNNING", "PAUSED"] } },
        select: { id: true, userId: true, exchange: true, managed: true },
      });
      for (const a of agents) await refreshDailyPlan(a).catch(() => {});
      const day = new Date().toISOString().slice(0, 10);
      if (new Date().getUTCHours() === 0) {
        const key = `dailyplan:close:${day}`;
        if (await redis.set(key, "1", "EX", 86_400, "NX")) {
          for (const a of agents) await closeDailyPlan(a.id).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn("daily plan cycle error", { module: "dailyplan", errorCode: String(e).slice(0, 120) });
    }
  }, 5 * 60_000);

  // signal-factory data-freshness watchdog — every 5 min, registered in
  // JobRegistry via jobRun; on stale/unreachable data it raises an Incident
  // and flips dataFresh() so setup production is skipped.
  setInterval(async () => {
    try {
      const { jobRun } = await import("@/modules/signal-factory/jobs");
      const { runDataFreshnessWatchdog } = await import("@/modules/signal-factory/watchdog");
      await jobRun("data-freshness-watchdog", "5min", runDataFreshnessWatchdog);
    } catch (e) {
      logger.warn("data freshness watchdog error", { module: "signal-factory", errorCode: String(e).slice(0, 120) });
    }
  }, 5 * 60_000);

  // signal-factory market scan — hourly due-check; each enabled config scans
  // when its own scanEveryHours has elapsed (tracked per-user in SystemSetting).
  setInterval(async () => {
    try {
      const { jobRun } = await import("@/modules/signal-factory/jobs");
      const { scanDueConfigs } = await import("@/modules/signal-factory/setups");
      await jobRun("market-scan", "1h", scanDueConfigs, { kind: "BULLMQ" });
    } catch (e) {
      logger.warn("market scan scheduler error", { module: "signal-factory", errorCode: String(e).slice(0, 120) });
    }
  }, 60 * 60_000);

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
    await repeatable(QUEUE_NAMES.CLEANUP, "cleanup-logs", { type: "OLD_LOGS" }, 24 * 3_600_000);
    await repeatable(QUEUE_NAMES.CLEANUP, "sqlite-vacuum", { type: "SQLITE_VACUUM" }, 7 * 24 * 3_600_000);
    await repeatable(QUEUE_NAMES.CLEANUP, "disk-check", { type: "DISK_CHECK" }, 6 * 3_600_000);
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
