import { prisma } from "@/infrastructure/database/prisma";
import { encrypt, maskSecret } from "@/infrastructure/encryption/crypto";
import { adapterWithCredentials, adapterForUser, exchangeLabel } from "./registry";
import { AppError } from "@/shared/errors";
import { logActivity } from "@/modules/activity/service";
import { notify } from "@/modules/notifications/service";
import { enqueue, QUEUE_NAMES, type ReferralJobData } from "@/infrastructure/queue/queues";

/**
 * Exchange account connection flow:
 *   Save (encrypted) → Decrypt internally → Connection Test → Fetch Balance → Success
 *
 * Secrets are AES-256-GCM encrypted at rest. Only a non-reversible mask
 * is ever exposed to UI/Admin. KuCoin accounts additionally carry a signed
 * passphrase (third credential) in apiPassphraseEnc.
 */
export async function connectExchange(opts: {
  userId: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase?: string;
  exchange?: string;
}) {
  const exchange = (opts.exchange ?? "NOBITEX").toUpperCase();
  if (!opts.apiKey?.trim() || !opts.apiSecret?.trim()) {
    throw new AppError("VALIDATION", 400, { reason: "apiKey/apiSecret required" });
  }
  if (exchange === "KUCOIN" && !opts.apiPassphrase?.trim()) {
    throw new AppError("VALIDATION", 400, { reason: "apiPassphrase required for KUCOIN" });
  }

  // connection test happens BEFORE persisting — no bad creds stored
  const adapter = adapterWithCredentials(exchange, {
    apiKey: opts.apiKey.trim(),
    apiSecret: opts.apiSecret.trim(),
    apiPassphrase: opts.apiPassphrase?.trim(),
    userId: opts.userId,
  });
  const ok = await adapter.validateCredentials();
  if (!ok) throw new AppError("EXCHANGE_CONNECTION_FAILED", 502);

  const balances = await adapter.getBalance().catch(() => []);
  const label = exchangeLabel(exchange);
  const secretFields = {
    apiKeyEnc: encrypt(opts.apiKey.trim()),
    apiSecretEnc: encrypt(opts.apiSecret.trim()),
    apiPassphraseEnc: opts.apiPassphrase?.trim() ? encrypt(opts.apiPassphrase.trim()) : null,
  };

  const account = await prisma.exchangeAccount.upsert({
    where: { userId_exchange: { userId: opts.userId, exchange } },
    create: {
      userId: opts.userId,
      exchange,
      label,
      ...secretFields,
      apiKeyMask: maskSecret(opts.apiKey.trim()),
      status: "CONNECTED",
      lastCheckedAt: new Date(),
    },
    update: {
      ...secretFields,
      apiKeyMask: maskSecret(opts.apiKey.trim()),
      status: "CONNECTED",
      lastCheckedAt: new Date(),
      lastError: null,
    },
  });

  await logActivity({
    userId: opts.userId, action: "API_CONNECT",
    entityType: "exchangeAccount", entityId: account.id, metadata: { exchange },
  });
  await notify({
    userId: opts.userId, type: "API_CONNECTED", severity: "SUCCESS",
    title: "اتصال صرافی", body: `حساب ${label} شما با موفقیت متصل شد.`,
  });

  // referral condition #2 — API connected
  const referral = await prisma.referral.findUnique({ where: { refereeId: opts.userId } });
  if (referral && !referral.apiConnected) {
    await enqueue<ReferralJobData>(QUEUE_NAMES.REFERRAL, "check", {
      referralId: referral.id, check: "API_CONNECTED",
    });
  }

  return { account, balances };
}

export async function testConnection(userId: string, exchange = "NOBITEX") {
  exchange = exchange.toUpperCase();
  const account = await prisma.exchangeAccount.findUnique({
    where: { userId_exchange: { userId, exchange } },
  });
  if (!account) throw new AppError("NO_EXCHANGE_ACCOUNT", 412);
  const adapter = await adapterForUser(userId, exchange);
  const ok = await adapter.validateCredentials();
  const balances = ok ? await adapter.getBalance().catch(() => []) : [];
  await prisma.exchangeAccount.update({
    where: { id: account.id },
    data: {
      status: ok ? "CONNECTED" : "FAILED",
      lastCheckedAt: new Date(),
      lastError: ok ? null : "اعتبارسنجی کلید ناموفق بود",
    },
  });
  return { ok, balances };
}

export async function getBalances(userId: string, exchange = "NOBITEX") {
  exchange = exchange.toUpperCase();
  const account = await prisma.exchangeAccount.findUnique({
    where: { userId_exchange: { userId, exchange } },
  });
  if (!account) throw new AppError("NO_EXCHANGE_ACCOUNT", 412);
  const adapter = await adapterForUser(userId, exchange);
  return adapter.getBalance();
}

export async function disconnectExchange(userId: string, exchange = "NOBITEX") {
  exchange = exchange.toUpperCase();
  const account = await prisma.exchangeAccount.findUnique({
    where: { userId_exchange: { userId, exchange } },
  });
  if (!account) throw new AppError("NOT_FOUND", 404);
  await prisma.exchangeAccount.update({
    where: { id: account.id },
    data: { status: "DISCONNECTED" },
  });
  await logActivity({
    userId, action: "API_DISCONNECT", entityType: "exchangeAccount", entityId: account.id,
    metadata: { exchange },
  });
}

export async function listAccounts(userId: string) {
  return prisma.exchangeAccount.findMany({
    where: { userId },
    select: {
      id: true, exchange: true, label: true, apiKeyMask: true,
      status: true, lastCheckedAt: true, lastError: true, createdAt: true,
    },
  });
}
