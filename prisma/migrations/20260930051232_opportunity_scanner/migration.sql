-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "marketType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopLossPct" REAL NOT NULL,
    "takeProfitPct" REAL NOT NULL,
    "stopLossPrice" REAL NOT NULL,
    "takeProfitPrice" REAL NOT NULL,
    "grossReturnPct" REAL NOT NULL,
    "totalCostPct" REAL NOT NULL,
    "netReturnPct" REAL NOT NULL,
    "riskReward" REAL NOT NULL,
    "score" REAL NOT NULL,
    "reasons" TEXT NOT NULL,
    "features" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "horizonCandles" INTEGER NOT NULL DEFAULT 20,
    "outcome" TEXT,
    "outcomePnlPct" REAL,
    "evaluatedAt" DATETIME,
    "liveStrategyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Opportunity_userId_createdAt_idx" ON "Opportunity"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Opportunity_status_idx" ON "Opportunity"("status");

-- CreateIndex
CREATE INDEX "Opportunity_symbol_exchange_idx" ON "Opportunity"("symbol", "exchange");
