-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LiveStrategy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "pairId" TEXT,
    "symbol" TEXT NOT NULL,
    "allocatedCapital" REAL NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'REAL',
    "status" TEXT NOT NULL DEFAULT 'STARTING',
    "stopPolicy" TEXT,
    "circuitBreakerFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSignalAt" DATETIME,
    "lastError" TEXT,
    "stats" TEXT NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiveStrategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LiveStrategy_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LiveStrategy_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StrategyVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LiveStrategy_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "Pair" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_LiveStrategy" ("allocatedCapital", "circuitBreakerFailures", "createdAt", "id", "lastError", "lastSignalAt", "pairId", "startedAt", "stats", "status", "stopPolicy", "stoppedAt", "strategyId", "symbol", "updatedAt", "userId", "versionId") SELECT "allocatedCapital", "circuitBreakerFailures", "createdAt", "id", "lastError", "lastSignalAt", "pairId", "startedAt", "stats", "status", "stopPolicy", "stoppedAt", "strategyId", "symbol", "updatedAt", "userId", "versionId" FROM "LiveStrategy";
DROP TABLE "LiveStrategy";
ALTER TABLE "new_LiveStrategy" RENAME TO "LiveStrategy";
CREATE INDEX "LiveStrategy_userId_idx" ON "LiveStrategy"("userId");
CREATE INDEX "LiveStrategy_status_idx" ON "LiveStrategy"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
