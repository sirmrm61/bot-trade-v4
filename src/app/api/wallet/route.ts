import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { verifyLedger, postTransaction } from "@/modules/wallet/service";
import { AppError } from "@/shared/errors";
import { idempotencyKey as newIdemKey } from "@/shared/utils";

export const GET = api(async (_req, ctx) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId: ctx.userId } });
  const transactions = await prisma.walletTransaction.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const ledger = await verifyLedger(ctx.userId);
  return { wallet, transactions, ledger };
});

const chargeSchema = z.object({
  amount: z.number().int().min(10_000).max(500_000_000),
  idempotencyKey: z.string().max(128).optional(),
});

/**
 * User wallet top-up — simulated payment gateway.
 * Production: redirect to PSP callback; here credits instantly via ledger.
 * Idempotent: same idempotencyKey → same transaction.
 */
export const POST = api(async (req, ctx) => {
  const input = chargeSchema.parse(await body(req));
  const key = input.idempotencyKey ?? `charge:${ctx.userId}:${newIdemKey()}`;
  const tx = await postTransaction({
    userId: ctx.userId,
    type: "CHARGE",
    direction: "CREDIT",
    amount: input.amount,
    description: "شارژ کیف پول (درگاه آزمایشی)",
    idempotencyKey: key,
    metadata: { gateway: "simulated" },
  });
  if (!tx) throw new AppError("UNKNOWN", 500);
  return { ok: true, transaction: tx };
});
