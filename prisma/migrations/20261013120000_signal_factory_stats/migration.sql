-- AlterTable
ALTER TABLE "Setup" ADD COLUMN "meta" TEXT;

-- RedefineTables — PaperTrade.setupId nullable + ON DELETE SET NULL so the
-- 30-day setup cleanup keeps the paper-trade record while the link clears.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaperTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setupId" TEXT,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "amount" REAL NOT NULL,
    "invested" REAL NOT NULL,
    "tp1" REAL NOT NULL,
    "tp2" REAL NOT NULL,
    "sl" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "exitPrice" REAL,
    "exitReason" TEXT,
    "pnl" REAL,
    "pnlPct" REAL,
    "costsPct" REAL NOT NULL,
    "tp1Hit" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "meta" TEXT,
    CONSTRAINT "PaperTrade_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PaperTrade" ("amount", "closedAt", "costsPct", "entryPrice", "exitPrice", "exitReason", "id", "invested", "meta", "openedAt", "pnl", "pnlPct", "setupId", "side", "sl", "status", "symbol", "tp1", "tp1Hit", "tp2", "userId") SELECT "amount", "closedAt", "costsPct", "entryPrice", "exitPrice", "exitReason", "id", "invested", "meta", "openedAt", "pnl", "pnlPct", "setupId", "side", "sl", "status", "symbol", "tp1", "tp1Hit", "tp2", "userId" FROM "PaperTrade";
DROP TABLE "PaperTrade";
ALTER TABLE "new_PaperTrade" RENAME TO "PaperTrade";
CREATE UNIQUE INDEX "PaperTrade_setupId_key" ON "PaperTrade"("setupId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
