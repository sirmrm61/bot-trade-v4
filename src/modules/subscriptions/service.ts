import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { TX_TYPES } from "@/shared/constants";
import { postTransaction } from "@/modules/wallet/service";
import { getSetting } from "@/modules/settings/service";
import { idempotencyKey as newIdemKey } from "@/shared/utils";

/**
 * Subscription lifecycle:
 *   TRIAL → ACTIVE → EXPIRING → EXPIRED → GRACE_PERIOD → RESTRICTED
 *
 * Renewal stacks: new expiry = max(now, currentExpiry) + plan duration.
 * Used quota does not reset on renewal per spec.
 */

export async function currentSubscription(userId: string) {
  const sub = await prisma.userSubscription.findFirst({
    where: {
      userId,
      status: { in: ["TRIAL", "ACTIVE", "EXPIRING", "GRACE_PERIOD"] },
      expiresAt: { gt: new Date() },
    },
    include: { plan: true },
    orderBy: { expiresAt: "desc" },
  });
  if (sub) return sub;
  // fall back to the most recent sub for status display
  return prisma.userSubscription.findFirst({
    where: { userId },
    include: { plan: true },
    orderBy: { expiresAt: "desc" },
  });
}

/** Effective limits for a user: plan limits + per-user overrides. Admins are unlimited. */
export async function effectiveLimits(userId: string) {
  const [sub, user] = await Promise.all([
    currentSubscription(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
  ]);
  const unlimited = user?.role === "ADMIN";
  const plan = sub?.plan;
  let backtestLimit = plan?.backtestLimit ?? 0;
  let liveLimit = plan?.liveLimit ?? 0;
  if (plan) {
    const override = await prisma.userPlanOverride.findUnique({
      where: { userId_planId: { userId, planId: plan.id } },
    });
    if (override?.backtestLimit != null) backtestLimit = override.backtestLimit;
    if (override?.liveLimit != null) liveLimit = override.liveLimit;
  }
  if (unlimited) {
    backtestLimit = Number.MAX_SAFE_INTEGER;
    liveLimit = Number.MAX_SAFE_INTEGER;
  }
  return { subscription: sub, plan, backtestLimit, liveLimit, unlimited };
}

/** Backtests used in current subscription window. */
export async function backtestUsage(userId: string) {
  const { subscription } = await effectiveLimits(userId);
  if (!subscription) return 0;
  return prisma.backtest.count({
    where: { userId, quotaConsumed: true, createdAt: { gte: subscription.startsAt } },
  });
}

export async function liveUsage(userId: string) {
  return prisma.liveStrategy.count({
    where: { userId, status: { in: ["STARTING", "RUNNING", "PAUSED", "DEGRADED", "STOPPING"] } },
  });
}

export function isSubscriptionActive(status: string | undefined, expiresAt?: Date | null): boolean {
  if (!status) return false;
  if (["TRIAL", "ACTIVE", "EXPIRING"].includes(status)) return !expiresAt || expiresAt > new Date();
  if (status === "GRACE_PERIOD") return true; // grace: can renew, no new live
  return false;
}

/** Purchase a plan — debits wallet via ledger, stacks expiry. */
export async function purchasePlan(opts: { userId: string; planId: string; idempotencyKey?: string }) {
  const plan = await prisma.plan.findUnique({ where: { id: opts.planId } });
  if (!plan || !plan.active) throw new AppError("NOT_FOUND", 404);

  const override = await prisma.userPlanOverride.findUnique({
    where: { userId_planId: { userId: opts.userId, planId: plan.id } },
  });
  let price = override?.customPrice ?? plan.price;
  if (override?.discountPct) price = Math.round(price * (1 - override.discountPct / 100));
  const days = override?.customDays ?? plan.durationDays;
  const key = opts.idempotencyKey ?? newIdemKey();

  // debit wallet (throws INSUFFICIENT_BALANCE) — idempotent on key
  if (price > 0) {
    await postTransaction({
      userId: opts.userId,
      type: TX_TYPES.SUBSCRIPTION,
      direction: "DEBIT",
      amount: price,
      description: `خرید اشتراک ${plan.name}`,
      idempotencyKey: `sub:${key}`,
      metadata: { planId: plan.id, planName: plan.name },
    });
  }

  const existing = await currentSubscription(opts.userId);
  const base =
    existing && existing.expiresAt > new Date() ? existing.expiresAt.getTime() : Date.now();
  const expiresAt = new Date(base + days * 86_400_000);
  const graceDays = await getSetting<number>("GRACE_PERIOD_DAYS");

  return prisma.userSubscription.create({
    data: {
      userId: opts.userId,
      planId: plan.id,
      startsAt: new Date(base > Date.now() ? base : Date.now()),
      expiresAt,
      graceEndsAt: new Date(expiresAt.getTime() + graceDays * 86_400_000),
      source: "PURCHASE",
      pricePaid: price,
      status: "ACTIVE",
    },
    include: { plan: true },
  });
}

/**
 * Expiry sweeper — run by subscriptionQueue worker.
 * ACTIVE → EXPIRED → GRACE_PERIOD → RESTRICTED
 */
export async function sweepExpirations() {
  const now = new Date();
  const graceDays = await getSetting<number>("GRACE_PERIOD_DAYS");

  // expiring soon notification (within 48h)
  const expiring = await prisma.userSubscription.updateMany({
    where: {
      status: "ACTIVE",
      expiresAt: { gt: now, lt: new Date(now.getTime() + 48 * 3_600_000) },
    },
    data: { status: "EXPIRING" },
  });

  const expired = await prisma.userSubscription.updateMany({
    where: { status: { in: ["ACTIVE", "EXPIRING"] }, expiresAt: { lte: now } },
    data: {
      status: "GRACE_PERIOD",
      graceEndsAt: new Date(now.getTime() + graceDays * 86_400_000),
    },
  });

  const restricted = await prisma.userSubscription.updateMany({
    where: { status: "GRACE_PERIOD", graceEndsAt: { lte: now } },
    data: { status: "RESTRICTED" },
  });

  return { expiring: expiring.count, expired: expired.count, restricted: restricted.count };
}
