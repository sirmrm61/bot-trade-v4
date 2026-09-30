-- AlterTable
ALTER TABLE "BacktestTrade" ADD COLUMN "trace" TEXT;
ALTER TABLE "BacktestTrade" ADD COLUMN "traceId" TEXT;

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "backtestId" TEXT,
    "refId" TEXT,
    "seq" INTEGER NOT NULL,
    "ts" BIGINT NOT NULL,
    "stage" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "symbol" TEXT,
    "barIndex" INTEGER,
    "candleTs" BIGINT,
    "data" TEXT,
    CONSTRAINT "TraceEvent_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Backtest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "versionId" TEXT,
    "pairId" TEXT,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "initialBalance" REAL NOT NULL,
    "feePct" REAL NOT NULL DEFAULT 0.25,
    "slippagePct" REAL NOT NULL DEFAULT 0.05,
    "executionDelayMs" INTEGER NOT NULL DEFAULT 0,
    "partialFill" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "quotaConsumed" BOOLEAN NOT NULL DEFAULT false,
    "finalBalance" REAL,
    "netProfit" REAL,
    "profitPct" REAL,
    "winRate" REAL,
    "lossRate" REAL,
    "totalTrades" INTEGER,
    "winningTrades" INTEGER,
    "losingTrades" INTEGER,
    "avgProfit" REAL,
    "avgLoss" REAL,
    "maxDrawdown" REAL,
    "profitFactor" REAL,
    "largestWin" REAL,
    "largestLoss" REAL,
    "avgTradeDurationMin" REAL,
    "equityCurve" TEXT,
    "results" TEXT,
    "idempotencyKey" TEXT,
    "traceLevel" TEXT NOT NULL DEFAULT 'OFF',
    "traceSymbol" TEXT,
    "strictCausality" BOOLEAN NOT NULL DEFAULT false,
    "ambiguityPolicy" TEXT NOT NULL DEFAULT 'SL_FIRST',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "Backtest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Backtest_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Backtest_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StrategyVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Backtest_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "Pair" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Backtest" ("avgLoss", "avgProfit", "avgTradeDurationMin", "completedAt", "createdAt", "endDate", "equityCurve", "error", "executionDelayMs", "feePct", "finalBalance", "id", "idempotencyKey", "initialBalance", "largestLoss", "largestWin", "losingTrades", "lossRate", "maxDrawdown", "netProfit", "pairId", "partialFill", "profitFactor", "profitPct", "progress", "quotaConsumed", "results", "slippagePct", "startDate", "startedAt", "status", "strategyId", "symbol", "timeframe", "totalTrades", "userId", "versionId", "winRate", "winningTrades") SELECT "avgLoss", "avgProfit", "avgTradeDurationMin", "completedAt", "createdAt", "endDate", "equityCurve", "error", "executionDelayMs", "feePct", "finalBalance", "id", "idempotencyKey", "initialBalance", "largestLoss", "largestWin", "losingTrades", "lossRate", "maxDrawdown", "netProfit", "pairId", "partialFill", "profitFactor", "profitPct", "progress", "quotaConsumed", "results", "slippagePct", "startDate", "startedAt", "status", "strategyId", "symbol", "timeframe", "totalTrades", "userId", "versionId", "winRate", "winningTrades" FROM "Backtest";
DROP TABLE "Backtest";
ALTER TABLE "new_Backtest" RENAME TO "Backtest";
CREATE UNIQUE INDEX "Backtest_idempotencyKey_key" ON "Backtest"("idempotencyKey");
CREATE INDEX "Backtest_userId_createdAt_idx" ON "Backtest"("userId", "createdAt");
CREATE INDEX "Backtest_status_idx" ON "Backtest"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TraceEvent_runId_seq_idx" ON "TraceEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX "TraceEvent_refId_idx" ON "TraceEvent"("refId");

-- CreateIndex
CREATE INDEX "TraceEvent_backtestId_idx" ON "TraceEvent"("backtestId");

-- CreateIndex
CREATE INDEX "BacktestTrade_traceId_idx" ON "BacktestTrade"("traceId");
