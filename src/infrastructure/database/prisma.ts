import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/**
 * Prisma 7 driver-adapter setup.
 * Phase 1: SQLite via better-sqlite3.
 * Postgres migration path: swap adapter for @prisma/adapter-pg —
 * the schema has no SQLite-specific constructs.
 */

function sqliteFile(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  const file = url.replace(/^file:/, "");
  return path.isAbsolute(file) ? file : path.join(/* turbopackIgnore: true */ process.cwd(), file);
}

const adapter = new PrismaBetterSqlite3({ url: sqliteFile() });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
