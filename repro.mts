import { execSync } from "node:child_process";
// check both sqlite files for the new column using node:sqlite (node 22+)
import { DatabaseSync } from "node:sqlite";
for (const f of ["dev.db", "prisma/dev.db"]) {
  try {
    const db = new DatabaseSync(f);
    const cols = db.prepare("PRAGMA table_info(Backtest)").all() as { name: string }[];
    const hasTraceEvent = (db.prepare("SELECT name FROM sqlite_master WHERE name='TraceEvent'").all() as unknown[]).length > 0;
    console.log(f, "| Backtest cols:", cols.length,
      "| traceLevel:", cols.some((c) => c.name === "traceLevel"),
      "| TraceEvent:", hasTraceEvent,
      "| migrations:", (() => { try { return (db.prepare("SELECT COUNT(*) c FROM _prisma_migrations").get() as {c:number}).c; } catch { return "none"; } })());
  } catch (e) {
    console.log(f, "ERR", String(e).slice(0, 100));
  }
}
process.exit(0);
