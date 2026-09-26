import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Wallet ledger integration test — real SQLite via Prisma driver adapter.
 * Creates a throwaway DB from the committed migration SQL.
 */

const TEST_DB = path.join(process.cwd(), "test-wallet.db");
process.env.DATABASE_URL = `file:./test-wallet.db`;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

let prisma: Awaited<typeof import("@/infrastructure/database/prisma")>["prisma"];
let postTransaction: Awaited<typeof import("@/modules/wallet/service")>["postTransaction"];
let verifyLedger: Awaited<typeof import("@/modules/wallet/service")>["verifyLedger"];

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const migration = fs.readFileSync(
    path.join(process.cwd(), "prisma", "migrations", fs.readdirSync(path.join(process.cwd(), "prisma/migrations"))[0], "migration.sql"),
    "utf8",
  );
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(TEST_DB);
  db.exec(migration);
  db.close();

  ({ prisma } = await import("@/infrastructure/database/prisma"));
  ({ postTransaction, verifyLedger } = await import("@/modules/wallet/service"));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("wallet ledger", () => {
  it("credits then debits with correct running balance", async () => {
    const user = await prisma.user.create({
      data: { username: "wallettest", passwordHash: "x", referralCode: "WT1" },
    });

    const t1 = await postTransaction({ userId: user.id, type: "CHARGE", direction: "CREDIT", amount: 1_000_000 });
    expect(t1.balanceAfter).toBe(1_000_000);

    const t2 = await postTransaction({ userId: user.id, type: "SUBSCRIPTION", direction: "DEBIT", amount: 50_000 });
    expect(t2.balanceBefore).toBe(1_000_000);
    expect(t2.balanceAfter).toBe(950_000);

    const check = await verifyLedger(user.id);
    expect(check.ok).toBe(true);
    expect(check.ledgerBalance).toBe(950_000);
  });

  it("rejects negative balance", async () => {
    const user = await prisma.user.create({
      data: { username: "wallettest2", passwordHash: "x", referralCode: "WT2" },
    });
    await expect(
      postTransaction({ userId: user.id, type: "DEBIT", direction: "DEBIT", amount: 100 }),
    ).rejects.toThrow();
  });

  it("idempotency key returns the same transaction", async () => {
    const user = await prisma.user.create({
      data: { username: "wallettest3", passwordHash: "x", referralCode: "WT3" },
    });
    const key = "idem-" + crypto.randomUUID();
    const a = await postTransaction({ userId: user.id, type: "CHARGE", direction: "CREDIT", amount: 500, idempotencyKey: key });
    const b = await postTransaction({ userId: user.id, type: "CHARGE", direction: "CREDIT", amount: 500, idempotencyKey: key });
    expect(a.id).toBe(b.id);
    const check = await verifyLedger(user.id);
    expect(check.ledgerBalance).toBe(500); // credited once, not twice
  });
});
