import { prisma } from "@/infrastructure/database/prisma";
import { decrypt } from "@/infrastructure/encryption/crypto";
import { NobitexAdapter } from "./nobitex";
import type { ExchangeAdapter } from "./types";
import { AppError } from "@/shared/errors";

/**
 * Factory: builds the right ExchangeAdapter for a user's stored account.
 * Adding Binance/Bybit later = new adapter + one case here.
 */
export async function adapterForUser(
  userId: string,
  exchange = "NOBITEX",
  workerId?: string,
): Promise<ExchangeAdapter> {
  const account = await prisma.exchangeAccount.findUnique({
    where: { userId_exchange: { userId, exchange } },
  });
  if (!account || account.status === "DISCONNECTED") {
    throw new AppError("NO_EXCHANGE_ACCOUNT", 412);
  }
  const apiKey = decrypt(account.apiKeyEnc);
  const apiSecret = decrypt(account.apiSecretEnc);

  switch (exchange) {
    case "NOBITEX":
      return new NobitexAdapter({ apiKey, apiSecret, userId, workerId });
    default:
      throw new AppError("VALIDATION", 400, { exchange });
  }
}

/** Public-data adapter without credentials (market data, candles, stats). */
export function publicAdapter(): ExchangeAdapter {
  return new NobitexAdapter({ apiKey: "" });
}
