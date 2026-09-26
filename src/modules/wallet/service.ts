import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { referenceNumber } from "@/shared/utils";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Wallet Ledger — the single writer for all balance changes.
 *
 * Rules (non-negotiable):
 * - Every balance change creates exactly one WalletTransaction.
 * - balanceBefore / balanceAfter are recorded on the transaction.
 * - Balance can never go negative.
 * - Idempotent: same idempotencyKey returns the existing transaction.
 * - Wallet.version provides optimistic concurrency inside a DB tx.
 */

export interface LedgerEntry {
  userId: string;
  type: string; // TX_TYPES
  direction: "CREDIT" | "DEBIT";
  amount: number; // positive, تومان
  description?: string;
  metadata?: Record<string, unknown>;
  createdById?: string;
  idempotencyKey?: string;
  referenceNumber?: string;
}

async function getOrCreateWallet(userId: string, tx: Prisma.TransactionClient) {
  let wallet = await tx.wallet.findUnique({ where: { userId } });
  if (!wallet) wallet = await tx.wallet.create({ data: { userId } });
  return wallet;
}

export async function postTransaction(entry: LedgerEntry) {
  if (entry.amount <= 0 || !Number.isFinite(entry.amount)) {
    throw new AppError("VALIDATION", 400, { reason: "amount must be positive" });
  }

  // Idempotency: if this key already produced a transaction, return it.
  if (entry.idempotencyKey) {
    const existing = await prisma.walletTransaction.findUnique({
      where: { idempotencyKey: entry.idempotencyKey },
    });
    if (existing) return existing;
  }

  return prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(entry.userId, tx);
    const delta = entry.direction === "CREDIT" ? entry.amount : -entry.amount;
    const next = wallet.balance + delta;

    if (next < 0) throw new AppError("INSUFFICIENT_BALANCE", 402);

    // optimistic lock — fails if a concurrent write changed the wallet
    const updated = await tx.wallet.updateMany({
      where: { id: wallet.id, version: wallet.version },
      data: { balance: next, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new AppError("DUPLICATE_OPERATION", 409, { reason: "wallet version conflict" });
    }

    return tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId: entry.userId,
        type: entry.type,
        direction: entry.direction,
        amount: entry.amount,
        balanceBefore: wallet.balance,
        balanceAfter: next,
        description: entry.description,
        referenceNumber: entry.referenceNumber ?? referenceNumber(),
        idempotencyKey: entry.idempotencyKey,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        createdById: entry.createdById,
      },
    });
  });
}

/** Admin manual charge — records bank details in metadata per spec. */
export async function adminCharge(opts: {
  userId: string;
  amount: number;
  adminId: string;
  description: string;
  referenceNumber: string;
  bankName?: string;
  depositTime?: string;
  idempotencyKey?: string;
}) {
  return postTransaction({
    userId: opts.userId,
    type: "CHARGE",
    direction: "CREDIT",
    amount: opts.amount,
    description: opts.description,
    referenceNumber: opts.referenceNumber,
    createdById: opts.adminId,
    idempotencyKey: opts.idempotencyKey,
    metadata: {
      bankName: opts.bankName,
      depositTime: opts.depositTime,
      manual: true,
    },
  });
}

export async function getBalance(userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  return wallet?.balance ?? 0;
}

/** Recompute balance from the ledger — integrity check. */
export async function verifyLedger(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) return { ok: true, ledgerBalance: 0, storedBalance: 0 };
  const agg = await prisma.walletTransaction.aggregate({
    where: { walletId: wallet.id },
    _sum: { amount: true },
  });
  const credits = await prisma.walletTransaction.aggregate({
    where: { walletId: wallet.id, direction: "CREDIT" },
    _sum: { amount: true },
  });
  const debits = await prisma.walletTransaction.aggregate({
    where: { walletId: wallet.id, direction: "DEBIT" },
    _sum: { amount: true },
  });
  void agg;
  const ledgerBalance = (credits._sum.amount ?? 0) - (debits._sum.amount ?? 0);
  return { ok: ledgerBalance === wallet.balance, ledgerBalance, storedBalance: wallet.balance };
}
