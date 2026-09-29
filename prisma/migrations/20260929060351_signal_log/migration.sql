-- CreateTable
CREATE TABLE "SignalLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "liveStrategyId" TEXT,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "score" REAL,
    "side" TEXT,
    "decision" TEXT NOT NULL,
    "features" TEXT NOT NULL,
    "context" TEXT,
    "tradeId" TEXT,
    "outcomePnlPct" REAL,
    "outcomeReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignalLog_liveStrategyId_fkey" FOREIGN KEY ("liveStrategyId") REFERENCES "LiveStrategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SignalLog_liveStrategyId_createdAt_idx" ON "SignalLog"("liveStrategyId", "createdAt");

-- CreateIndex
CREATE INDEX "SignalLog_symbol_kind_decision_idx" ON "SignalLog"("symbol", "kind", "decision");

-- CreateIndex
CREATE INDEX "SignalLog_tradeId_idx" ON "SignalLog"("tradeId");
