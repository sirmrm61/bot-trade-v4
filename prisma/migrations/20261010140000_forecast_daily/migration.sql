-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'LOGREG',
    "exchange" TEXT NOT NULL,
    "symbolScope" TEXT NOT NULL DEFAULT '*',
    "timeframe" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "barrierK" REAL NOT NULL DEFAULT 1.5,
    "featureNames" TEXT NOT NULL,
    "weights" TEXT NOT NULL,
    "trainMetrics" TEXT NOT NULL,
    "testMetrics" TEXT NOT NULL,
    "samplesTrain" INTEGER NOT NULL DEFAULT 0,
    "samplesTest" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "beatsBaseline" BOOLEAN NOT NULL DEFAULT false,
    "liveAccuracy" REAL,
    "deactivatedReason" TEXT,
    "supersedesId" TEXT,
    "trainedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelVersionId" TEXT,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "probability" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "directionHint" TEXT NOT NULL,
    "priceAt" REAL NOT NULL,
    "resolveAt" DATETIME NOT NULL,
    "outcome" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Prediction_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DailyPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT,
    "userId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'BUILDING',
    "sizeScale" REAL NOT NULL DEFAULT 1,
    "peakPnlPct" REAL NOT NULL DEFAULT 0,
    "realizedPnlPct" REAL NOT NULL DEFAULT 0,
    "targetMin" REAL NOT NULL DEFAULT 0.5,
    "targetNormal" REAL NOT NULL DEFAULT 1.0,
    "targetStretch" REAL NOT NULL DEFAULT 5.0,
    "tradesToday" INTEGER NOT NULL DEFAULT 0,
    "maxTrades" INTEGER NOT NULL DEFAULT 8,
    "forecastNote" TEXT,
    "lockedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DailyPlan_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "TradingAgent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ModelVersion_exchange_symbolScope_timeframe_horizon_active_idx" ON "ModelVersion"("exchange", "symbolScope", "timeframe", "horizon", "active");

-- CreateIndex
CREATE INDEX "Prediction_symbol_horizon_resolveAt_idx" ON "Prediction"("symbol", "horizon", "resolveAt");

-- CreateIndex
CREATE INDEX "Prediction_resolveAt_outcome_idx" ON "Prediction"("resolveAt", "outcome");

-- CreateIndex
CREATE INDEX "DailyPlan_userId_date_idx" ON "DailyPlan"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_agentId_date_key" ON "DailyPlan"("agentId", "date");
