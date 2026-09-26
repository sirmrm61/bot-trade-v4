import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { createSessionToken, type SessionPayload } from "./session";
import { sha256 } from "@/infrastructure/encryption/crypto";
import { logActivity } from "@/modules/activity/service";
import { SUBSCRIPTION_STATUS } from "@/shared/constants";

const SESSION_TTL_HOURS = 24 * 7;

export function generateReferralCode(username: string): string {
  return `${username.slice(0, 6).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/** Register a new user — creates wallet + free subscription atomically. */
export async function registerUser(input: {
  username: string;
  email?: string;
  mobile?: string;
  password: string;
  referralCode?: string;
  ip?: string;
}) {
  const username = input.username.trim().toLowerCase();
  const email = input.email?.trim().toLowerCase() || null;
  const mobile = input.mobile?.trim() || null;

  if (await prisma.user.findUnique({ where: { username } })) {
    throw new AppError("USERNAME_TAKEN", 409);
  }
  if (email && (await prisma.user.findUnique({ where: { email } }))) {
    throw new AppError("EMAIL_TAKEN", 409);
  }

  const referrer = input.referralCode
    ? await prisma.user.findUnique({ where: { referralCode: input.referralCode.trim() } })
    : null;

  const passwordHash = await bcrypt.hash(input.password, 12);
  const freePlan = await prisma.plan.findFirst({
    where: { OR: [{ slug: "free" }, { isDefault: true }], active: true },
    orderBy: { price: "asc" },
  });

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        username,
        email,
        mobile,
        passwordHash,
        referralCode: generateReferralCode(username),
        referredById: referrer?.id ?? null,
      },
    });
    await tx.wallet.create({ data: { userId: u.id } });
    if (freePlan) {
      const expiresAt = new Date(Date.now() + freePlan.durationDays * 86_400_000);
      await tx.userSubscription.create({
        data: {
          userId: u.id,
          planId: freePlan.id,
          expiresAt,
          graceEndsAt: null,
          source: "TRIAL",
          pricePaid: 0,
          status: SUBSCRIPTION_STATUS.TRIAL,
        },
      });
    }
    if (referrer) {
      await tx.referral.create({
        data: { referrerId: referrer.id, refereeId: u.id },
      });
    }
    return u;
  });

  await logActivity({
    userId: user.id,
    action: "REGISTER",
    entityType: "user",
    entityId: user.id,
    ip: input.ip,
    metadata: { referredBy: referrer?.username },
  });

  return user;
}

/** Login by username OR email + password. Mobile/OTP hooks reserved. */
export async function loginUser(input: {
  identifier: string; // username or email
  password: string;
  ip?: string;
  userAgent?: string;
}) {
  const id = input.identifier.trim().toLowerCase();
  const user = await prisma.user.findFirst({
    where: { OR: [{ username: id }, { email: id }] },
  });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
    throw new AppError("INVALID_CREDENTIALS", 401);
  }
  if (user.status === "SUSPENDED") throw new AppError("FORBIDDEN", 403);

  const payload: SessionPayload = { sub: user.id, role: user.role };
  const token = await createSessionToken(payload, `${SESSION_TTL_HOURS}h`);
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: sha256(token),
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000),
    },
  });

  await logActivity({ userId: user.id, action: "LOGIN", entityType: "user", entityId: user.id, ip: input.ip });

  return { user, token };
}

export async function logoutUser(token: string, userId?: string) {
  await prisma.session.updateMany({
    where: { tokenHash: sha256(token) },
    data: { revokedAt: new Date() },
  });
  if (userId) {
    await logActivity({ userId, action: "LOGOUT", entityType: "user", entityId: userId });
  }
}

export async function validateSession(token: string) {
  const hash = sha256(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  return session.user;
}

// OTP scaffolding — architecture-ready, not enforced in phase 1
export async function requestOtp(mobile: string) {
  void mobile;
  // Phase 2: generate code, store hash with TTL, send via SMS provider
  return { sent: false, reason: "OTP provider not configured" };
}
