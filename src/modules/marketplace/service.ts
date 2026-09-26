import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { TX_TYPES } from "@/shared/constants";
import { postTransaction } from "@/modules/wallet/service";
import { getSetting } from "@/modules/settings/service";
import { cloneStrategy, hasMaterialChanges, latestVersion } from "@/modules/strategies/service";
import { notify } from "@/modules/notifications/service";
import { logActivity } from "@/modules/activity/service";

/**
 * Marketplace — listing lifecycle:
 *   DRAFT → PENDING_REVIEW → APPROVED → PUBLISHED
 *                            ↘ REJECTED / SUSPENDED / ARCHIVED
 */

export async function createListing(opts: {
  userId: string;
  strategyId: string;
  title: string;
  description?: string;
  price: number;
  subscriptionDays?: number;
  imageUrl?: string;
}) {
  const strategy = await prisma.strategy.findFirst({
    where: { id: opts.strategyId, userId: opts.userId, status: { not: "DELETED" } },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404);
  const version = await latestVersion(strategy.id);
  if (!version) throw new AppError("STRATEGY_NOT_READY", 400);

  // resell rule — purchased clones must differ from parent
  if (strategy.origin === "PURCHASED" && !(await hasMaterialChanges(version.id))) {
    throw new AppError("FORBIDDEN", 403, { reason: "unchanged purchased strategy cannot be resold" });
  }

  // listing needs a completed backtest to show results
  const backtest = await prisma.backtest.findFirst({
    where: { strategyId: strategy.id, status: "COMPLETED" },
    orderBy: { completedAt: "desc" },
  });
  if (!backtest) throw new AppError("STRATEGY_NOT_READY", 400, { reason: "backtest required" });

  return prisma.marketplaceListing.create({
    data: {
      strategyId: strategy.id,
      versionId: version.id,
      sellerId: opts.userId,
      title: opts.title,
      description: opts.description,
      price: opts.price,
      subscriptionDays: opts.subscriptionDays ?? 0,
      imageUrl: opts.imageUrl,
      status: "DRAFT",
    },
  });
}

export async function submitForReview(userId: string, listingId: string) {
  const listing = await prisma.marketplaceListing.findFirst({
    where: { id: listingId, sellerId: userId },
  });
  if (!listing) throw new AppError("NOT_FOUND", 404);
  if (!["DRAFT", "REJECTED"].includes(listing.status)) {
    throw new AppError("VALIDATION", 400, { reason: "invalid status transition" });
  }
  return prisma.marketplaceListing.update({
    where: { id: listingId },
    data: { status: "PENDING_REVIEW" },
  });
}

export async function reviewListing(opts: {
  adminId: string;
  listingId: string;
  approve: boolean;
  note?: string;
}) {
  const listing = await prisma.marketplaceListing.findUnique({ where: { id: opts.listingId } });
  if (!listing || listing.status !== "PENDING_REVIEW") throw new AppError("NOT_FOUND", 404);
  const updated = await prisma.marketplaceListing.update({
    where: { id: listing.id },
    data: {
      status: opts.approve ? "PUBLISHED" : "REJECTED",
      reviewNote: opts.note,
      reviewedById: opts.adminId,
      reviewedAt: new Date(),
      publishedAt: opts.approve ? new Date() : null,
    },
  });
  await notify({
    userId: listing.sellerId,
    type: "SYSTEM",
    severity: opts.approve ? "SUCCESS" : "WARNING",
    title: opts.approve ? "استراتژی تأیید شد" : "استراتژی رد شد",
    body: opts.approve
      ? `استراتژی «${listing.title}» در بازار منتشر شد.`
      : `استراتژی «${listing.title}» تأیید نشد. ${opts.note ?? ""}`,
  });
  await logActivity({
    userId: opts.adminId, actorType: "ADMIN",
    action: opts.approve ? "LISTING_APPROVE" : "LISTING_REJECT",
    entityType: "listing", entityId: listing.id,
  });
  return updated;
}

/**
 * Purchase flow — atomic:
 *   Check Wallet → Create Purchase → Debit Buyer → Commission →
 *   Credit Seller → Record Commission → Activate Access (clone)
 */
export async function purchaseStrategy(opts: {
  buyerId: string;
  listingId: string;
  idempotencyKey?: string;
}) {
  const key = opts.idempotencyKey ?? `purchase:${opts.buyerId}:${opts.listingId}`;
  const dup = await prisma.strategyPurchase.findUnique({ where: { idempotencyKey: key } });
  if (dup) return dup;

  const listing = await prisma.marketplaceListing.findUnique({
    where: { id: opts.listingId },
    include: { seller: true },
  });
  if (!listing || listing.status !== "PUBLISHED") throw new AppError("NOT_FOUND", 404);
  if (listing.sellerId === opts.buyerId) throw new AppError("CANNOT_BUY_OWN_STRATEGY", 400);

  // per-user commission override then system default
  const sellerOverride = await prisma.systemSetting.findUnique({
    where: { key: `COMMISSION_PCT:${listing.sellerId}` },
  });
  const commissionPct = sellerOverride
    ? Number(JSON.parse(sellerOverride.value))
    : await getSetting<number>("COMMISSION_PCT");
  const commissionAmt = Math.round((listing.price * commissionPct) / 100);
  const sellerNet = listing.price - commissionAmt;

  // 1-3. debit buyer — throws INSUFFICIENT_BALANCE; idempotent
  await postTransaction({
    userId: opts.buyerId,
    type: TX_TYPES.STRATEGY_PURCHASE,
    direction: "DEBIT",
    amount: listing.price,
    description: `خرید استراتژی «${listing.title}»`,
    idempotencyKey: `${key}:debit`,
    metadata: { listingId: listing.id },
  });

  // 4-5. credit seller + record platform commission
  await postTransaction({
    userId: listing.sellerId,
    type: TX_TYPES.STRATEGY_SALE,
    direction: "CREDIT",
    amount: sellerNet,
    description: `فروش استراتژی «${listing.title}»`,
    idempotencyKey: `${key}:seller-credit`,
    metadata: { listingId: listing.id, buyerId: opts.buyerId },
  });
  if (commissionAmt > 0) {
    await postTransaction({
      userId: listing.sellerId,
      type: TX_TYPES.PLATFORM_COMMISSION,
      direction: "DEBIT",
      amount: commissionAmt,
      description: `کمیسیون پلتفرم برای «${listing.title}»`,
      idempotencyKey: `${key}:commission`,
      metadata: { listingId: listing.id },
    });
  }

  // 6. clone the pinned version for the buyer
  const { strategy: cloned } = await cloneStrategy({
    userId: opts.buyerId,
    sourceVersionId: listing.versionId,
    name: listing.title,
    purchasedListingId: listing.id,
  });

  const expiresAt = listing.subscriptionDays > 0
    ? new Date(Date.now() + listing.subscriptionDays * 86_400_000)
    : null;

  const purchase = await prisma.strategyPurchase.create({
    data: {
      listingId: listing.id,
      versionId: listing.versionId, // pinned version — buyer keeps it
      buyerId: opts.buyerId,
      sellerId: listing.sellerId,
      price: listing.price,
      commissionPct,
      commissionAmt,
      sellerNet,
      clonedStrategyId: cloned.id,
      expiresAt,
      idempotencyKey: key,
    },
  });

  await notify({ userId: opts.buyerId, type: "STRATEGY_PURCHASED", severity: "SUCCESS", title: "خرید استراتژی", body: `استراتژی «${listing.title}» خریداری شد.` });
  await notify({ userId: listing.sellerId, type: "STRATEGY_SOLD", severity: "SUCCESS", title: "فروش استراتژی", body: `استراتژی «${listing.title}» فروخته شد.` });
  await logActivity({ userId: opts.buyerId, action: "PURCHASE", entityType: "purchase", entityId: purchase.id });
  return purchase;
}
