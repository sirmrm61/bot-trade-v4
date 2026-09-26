import { prisma } from "@/infrastructure/database/prisma";
import { getSetting } from "@/modules/settings/service";
import { notify } from "@/modules/notifications/service";
import { logActivity } from "@/modules/activity/service";
import { SUBSCRIPTION_STATUS } from "@/shared/constants";

/**
 * Referral — success requires ALL three:
 *   1. registered with referral code
 *   2. real Nobitex API connected
 *   3. first real live trade
 * → referrer gets +7 days (configurable). One bonus per referral.
 */

export async function markApiConnected(refereeId: string) {
  const referral = await prisma.referral.findUnique({ where: { refereeId } });
  if (!referral || referral.apiConnected) return;
  await prisma.referral.update({ where: { id: referral.id }, data: { apiConnected: true } });
  await tryGrantBonus(referral.id);
}

export async function markFirstLiveTrade(refereeId: string) {
  const referral = await prisma.referral.findUnique({ where: { refereeId } });
  if (!referral || referral.firstLiveTrade) return;
  await prisma.referral.update({ where: { id: referral.id }, data: { firstLiveTrade: true } });
  await tryGrantBonus(referral.id);
}

async function tryGrantBonus(referralId: string) {
  const referral = await prisma.referral.findUnique({ where: { id: referralId } });
  if (!referral || referral.completed) return;
  if (!(referral.registered && referral.apiConnected && referral.firstLiveTrade)) return;

  const bonusDays = referral.bonusDays || (await getSetting<number>("REFERRAL_BONUS_DAYS"));

  // extend referrer's current subscription (or create from default plan)
  const sub = await prisma.userSubscription.findFirst({
    where: { userId: referral.referrerId, status: { in: ["TRIAL", "ACTIVE", "EXPIRING", "GRACE_PERIOD"] } },
    orderBy: { expiresAt: "desc" },
    include: { plan: true },
  });
  if (sub) {
    const base = Math.max(sub.expiresAt.getTime(), Date.now());
    await prisma.userSubscription.update({
      where: { id: sub.id },
      data: { expiresAt: new Date(base + bonusDays * 86_400_000), source: sub.source },
    });
  } else {
    const plan = await prisma.plan.findFirst({ where: { isDefault: true, active: true } });
    if (plan) {
      await prisma.userSubscription.create({
        data: {
          userId: referral.referrerId,
          planId: plan.id,
          expiresAt: new Date(Date.now() + bonusDays * 86_400_000),
          source: "REFERRAL",
          pricePaid: 0,
          status: SUBSCRIPTION_STATUS.ACTIVE,
        },
      });
    }
  }

  await prisma.referral.update({
    where: { id: referral.id },
    data: { completed: true, bonusGrantedAt: new Date(), bonusDays },
  });
  await notify({
    userId: referral.referrerId, type: "REFERRAL_BONUS", severity: "SUCCESS",
    title: "پاداش رفرال", body: `رفرال شما تکمیل شد و ${bonusDays} روز به اشتراکتان اضافه شد.`,
  });
  await logActivity({
    userId: referral.referrerId, actorType: "SYSTEM", action: "REFERRAL_BONUS",
    entityType: "referral", entityId: referral.id,
  });
}
