import path from "node:path";

/** Imported FIRST by signal-factory-lifecycle.test.ts — env must be set before
 *  any module that instantiates the Prisma client is evaluated. */
export const TEST_DB = path.join(process.cwd(), "test-signal-factory-lifecycle.db");
process.env.DATABASE_URL = `file:./test-signal-factory-lifecycle.db`;
process.env.ENCRYPTION_KEY ??= "a".repeat(64);
