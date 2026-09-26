-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StrategyVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "strategyId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SIGNAL',
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "buyThreshold" REAL NOT NULL DEFAULT 0.35,
    "sellThreshold" REAL NOT NULL DEFAULT -0.35,
    "riskPerTradePct" REAL NOT NULL DEFAULT 1,
    "stopLossPct" REAL NOT NULL DEFAULT 1,
    "takeProfitPct" REAL NOT NULL DEFAULT 2,
    "trailingStop" BOOLEAN NOT NULL DEFAULT false,
    "trailingStopPct" REAL,
    "maxPositionPct" REAL NOT NULL DEFAULT 100,
    "orderType" TEXT NOT NULL DEFAULT 'MARKET',
    "config" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StrategyVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_StrategyVersion" ("buyThreshold", "config", "createdAt", "id", "maxPositionPct", "orderType", "riskPerTradePct", "sellThreshold", "stopLossPct", "strategyId", "symbol", "takeProfitPct", "timeframe", "trailingStop", "trailingStopPct", "versionNumber") SELECT "buyThreshold", "config", "createdAt", "id", "maxPositionPct", "orderType", "riskPerTradePct", "sellThreshold", "stopLossPct", "strategyId", "symbol", "takeProfitPct", "timeframe", "trailingStop", "trailingStopPct", "versionNumber" FROM "StrategyVersion";
DROP TABLE "StrategyVersion";
ALTER TABLE "new_StrategyVersion" RENAME TO "StrategyVersion";
CREATE INDEX "StrategyVersion_strategyId_idx" ON "StrategyVersion"("strategyId");
CREATE UNIQUE INDEX "StrategyVersion_strategyId_versionNumber_key" ON "StrategyVersion"("strategyId", "versionNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
