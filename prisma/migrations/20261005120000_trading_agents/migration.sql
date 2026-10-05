-- CreateTable
CREATE TABLE "TradingAgent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NOBITEX',
    "mode" TEXT NOT NULL DEFAULT 'PAPER',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "strategyId" TEXT,
    "liveStrategyId" TEXT,
    "tickIntervalSec" INTEGER NOT NULL DEFAULT 600,
    "lastTickAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" DATETIME,
    CONSTRAINT "TradingAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TradingAgent_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TradingAgentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TradingAgentLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "TradingAgent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TradingAgent_userId_status_idx" ON "TradingAgent"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAgent_userId_symbol_mode_key" ON "TradingAgent"("userId", "symbol", "mode");

-- CreateIndex
CREATE INDEX "TradingAgentLog_agentId_createdAt_idx" ON "TradingAgentLog"("agentId", "createdAt");
