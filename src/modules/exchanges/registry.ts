import { prisma } from "@/infrastructure/database/prisma";
import { decrypt } from "@/infrastructure/encryption/crypto";
import { NobitexAdapter } from "./nobitex";
import { KucoinAdapter, type KucoinCredentials } from "./kucoin";
import type { ExchangeAdapter } from "./types";
import { AppError } from "@/shared/errors";

/**
 * Factory: builds the right ExchangeAdapter for a user's stored account.
 * Adding a new exchange = new adapter + one case in each switch here.
 */

/** Exchanges the platform knows about — drives the account UI and scanners. */
export const EXCHANGES = [
  { id: "NOBITEX", label: "نوبیتکس", needsPassphrase: false, hint: "توکن API با دسترسی «فقط معامله»" },
  { id: "KUCOIN", label: "کوکوین", needsPassphrase: true, hint: "API Key + Secret + Passphrase (دسترسی Trade)" },
] as const;
export type ExchangeId = (typeof EXCHANGES)[number]["id"];

export function exchangeLabel(id: string): string {
  return EXCHANGES.find((e) => e.id === id)?.label ?? id;
}

export interface ExchangeCreds {
  apiKey: string;
  apiSecret?: string;
  apiPassphrase?: string;
  userId?: string;
  workerId?: string;
}

/** Build an adapter directly from credentials (connect-test before persisting). */
export function adapterWithCredentials(exchange: string, creds: ExchangeCreds): ExchangeAdapter {
  switch (exchange.toUpperCase()) {
    case "NOBITEX":
      return new NobitexAdapter({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, userId: creds.userId, workerId: creds.workerId });
    case "KUCOIN":
      return new KucoinAdapter(creds as KucoinCredentials);
    default:
      throw new AppError("VALIDATION", 400, { exchange });
  }
}

export async function adapterForUser(
  userId: string,
  exchange = "NOBITEX",
  workerId?: string,
): Promise<ExchangeAdapter> {
  const account = await prisma.exchangeAccount.findUnique({
    where: { userId_exchange: { userId, exchange } },
  });
  if (!account || account.status === "DISCONNECTED") {
    throw new AppError("NO_EXCHANGE_ACCOUNT", 412, { exchange });
  }
  return adapterWithCredentials(exchange, {
    apiKey: decrypt(account.apiKeyEnc),
    apiSecret: decrypt(account.apiSecretEnc),
    apiPassphrase: account.apiPassphraseEnc ? decrypt(account.apiPassphraseEnc) : undefined,
    userId,
    workerId,
  });
}

/** Public-data adapter without credentials (market data, candles, stats). */
export function publicAdapter(exchange = "NOBITEX"): ExchangeAdapter {
  return adapterWithCredentials(exchange, { apiKey: "" });
}
