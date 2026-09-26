import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { adminCharge } from "@/modules/wallet/service";
import { notify } from "@/modules/notifications/service";
import { logActivity } from "@/modules/activity/service";
import { AppError } from "@/shared/errors";
import { referenceNumber, idempotencyKey as newIdemKey } from "@/shared/utils";

export const GET = api(async () => {
  const wallets = await prisma.wallet.findMany({
    orderBy: { balance: "desc" },
    include: { user: { select: { username: true } } },
    take: 200,
  });
  return { wallets };
}, { admin: true });

const chargeSchema = z.object({
  userId: z.string(),
  amount: z.number().int().positive(),
  description: z.string().min(2),
  bankName: z.string().optional(),
  depositTime: z.string().optional(),
});

/** Admin manual wallet charge — full audit trail per spec. */
export const POST = api(async (req, ctx) => {
  const input = chargeSchema.parse(await body(req));
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new AppError("NOT_FOUND", 404);

  const trx = await adminCharge({
    userId: input.userId,
    amount: input.amount,
    adminId: ctx.userId,
    description: input.description,
    referenceNumber: referenceNumber("CHARGE"),
    bankName: input.bankName,
    depositTime: input.depositTime,
    idempotencyKey: `admincharge:${newIdemKey()}`,
  });

  await notify({
    userId: input.userId, type: "SYSTEM", severity: "SUCCESS",
    title: "شارژ کیف پول", body: `کیف پول شما ${input.amount.toLocaleString("fa-IR")} تومان شارژ شد.`,
  });
  await logActivity({
    userId: ctx.userId, actorType: "ADMIN", action: "WALLET_CHARGE",
    entityType: "walletTransaction", entityId: trx.id,
    metadata: { targetUser: user.username, amount: input.amount },
  });
  return { ok: true, transaction: trx };
}, { admin: true });
