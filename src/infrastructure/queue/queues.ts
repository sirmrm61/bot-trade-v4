import { Queue, type JobsOptions } from "bullmq";
import { createRedisConnection } from "../redis/client";

/**
 * Queue contracts — see docs/queue-contracts.md for full job specs.
 * Every queue name and job type is centralized here.
 */

export const QUEUE_NAMES = {
  BACKTEST: "backtestQueue",
  LIVE_STRATEGY: "liveStrategyQueue",
  ORDER: "orderQueue",
  MARKET_DATA: "marketDataQueue",
  RECONCILIATION: "reconciliationQueue",
  NOTIFICATION: "notificationQueue",
  SUBSCRIPTION: "subscriptionQueue",
  REFERRAL: "referralQueue",
  CLEANUP: "cleanupQueue",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---- Job payload types ------------------------------------------------

export interface BacktestJobData {
  backtestId: string;
}

export interface LiveStrategyJobData {
  liveStrategyId: string;
  action: "TICK" | "START" | "PAUSE" | "STOP";
}

export interface OrderJobData {
  orderId: string;
  action: "SUBMIT" | "MONITOR" | "CANCEL";
}

export interface MarketDataJobData {
  type: "SYNC_PAIRS" | "FETCH_CANDLES";
  symbol?: string;
  timeframe?: string;
}

export interface ReconciliationJobData {
  liveStrategyId?: string; // all strategies when omitted
}

export interface NotificationJobData {
  notificationId?: string; // internal notification to relay
  userId?: string;
  type?: string;
  title?: string;
  body?: string;
}

export interface SubscriptionJobData {
  type: "CHECK_EXPIRY";
}

export interface ReferralJobData {
  referralId: string;
  check: "API_CONNECTED" | "FIRST_LIVE_TRADE";
}

export interface CleanupJobData {
  type: "EXPIRED_SESSIONS" | "OLD_CANDLES" | "OLD_LOGS";
}

// ---- Queue registry -----------------------------------------------------

const connection = () => createRedisConnection();

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: connection() });
    queues.set(name, q);
  }
  return q;
}

export const defaultJobOpts: JobsOptions = {
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
};

export async function enqueue<T>(name: QueueName, jobName: string, data: T, opts?: JobsOptions) {
  const queue = getQueue(name);
  return queue.add(jobName, data as never, { ...defaultJobOpts, ...opts });
}
