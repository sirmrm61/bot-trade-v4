-- Agent intelligence: journal, guardrails bookkeeping, walk-forward results
ALTER TABLE "TradingAgent" ADD COLUMN "pausedUntil" DATETIME;
ALTER TABLE "LiveStrategy" ADD COLUMN "sizeScale" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "LiveStrategy" ADD COLUMN "candidateVersionId" TEXT;
ALTER TABLE "Trade" ADD COLUMN "meta" TEXT;
ALTER TABLE "Backtest" ADD COLUMN "trainMetrics" TEXT;
ALTER TABLE "Backtest" ADD COLUMN "testMetrics" TEXT;
ALTER TABLE "Backtest" ADD COLUMN "passed" BOOLEAN;
ALTER TABLE "Backtest" ADD COLUMN "hypothesis" TEXT;

CREATE TABLE "AgentJournal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "reason" TEXT,
  "data" TEXT,
  "strategyId" TEXT,
  "versionId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentJournal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "TradingAgent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentJournal_agentId_createdAt_idx" ON "AgentJournal"("agentId", "createdAt");
