import path from "node:path";

/** Imported FIRST by signal-factory-live.test.ts — env must be set before
 *  any module that instantiates the Prisma client is evaluated. */
export const TEST_DB = path.join(process.cwd(), "test-signal-factory-live.db");
process.env.DATABASE_URL = `file:./test-signal-factory-live.db`;
process.env.ENCRYPTION_KEY ??= "a".repeat(64);
