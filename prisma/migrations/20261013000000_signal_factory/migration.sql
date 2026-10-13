-- CreateTable
CREATE TABLE "SignalMakerConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'KUCOIN',
    "marketType" TEXT NOT NULL DEFAULT 'SPOT',
    "quote" TEXT NOT NULL DEFAULT 'USDT',
    "minVolume24h" REAL NOT NULL DEFAULT 0,
    "timeframes" TEXT NOT NULL DEFAULT '["4h","1h","1d"]',
    "scanEveryHours" INTEGER NOT NULL DEFAULT 4,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "liveTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SignalMakerConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "marketType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "typeKey" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "triggerPrice" REAL NOT NULL,
    "confirmRule" TEXT NOT NULL,
    "entryLow" REAL NOT NULL,
    "entryHigh" REAL NOT NULL,
    "tp1" REAL NOT NULL,
    "tp2" REAL NOT NULL,
    "sl" REAL NOT NULL,
    "invalidatePrice" REAL NOT NULL,
    "rr" REAL NOT NULL,
    "score" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "reasonFa" TEXT NOT NULL,
    "levelsMeta" TEXT NOT NULL,
    "executable" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'PROPOSED',
    "expiresAt" DATETIME NOT NULL,
    "priceAtScan" REAL NOT NULL,
    "backtestLabel" TEXT NOT NULL DEFAULT 'NOT_TESTED',
    "activatedAt" DATETIME,
    "closedAt" DATETIME,
    "outcome" TEXT,
    "outcomePnlPct" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Setup_configId_fkey" FOREIGN KEY ("configId") REFERENCES "SignalMakerConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SetupType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "expectancy" REAL NOT NULL DEFAULT 0,
    "pfTrain" REAL,
    "pfTest" REAL,
    "maxDD" REAL,
    "paperTrades" INTEGER NOT NULL DEFAULT 0,
    "paperExpectancy" REAL,
    "paperDays" INTEGER NOT NULL DEFAULT 0,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "degradedReason" TEXT,
    "weight" REAL NOT NULL DEFAULT 1,
    "liveApproved" BOOLEAN NOT NULL DEFAULT false,
    "liveApprovedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SetupBacktest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setupId" TEXT,
    "typeKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "feePct" REAL NOT NULL,
    "slippagePct" REAL NOT NULL,
    "trainMetrics" TEXT NOT NULL,
    "testMetrics" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "reasons" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PaperTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setupId" TEXT NOT NULL,
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
    CONSTRAINT "PaperTrade_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobRegistry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INTERVAL',
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);



-- CreateIndex
CREATE UNIQUE INDEX "SignalMakerConfig_userId_key" ON "SignalMakerConfig"("userId");

-- CreateIndex
CREATE INDEX "Setup_userId_state_idx" ON "Setup"("userId", "state");

-- CreateIndex
CREATE INDEX "Setup_typeKey_idx" ON "Setup"("typeKey");

-- CreateIndex
CREATE INDEX "Setup_symbol_direction_state_idx" ON "Setup"("symbol", "direction", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SetupType_key_key" ON "SetupType"("key");

-- CreateIndex
CREATE INDEX "SetupBacktest_typeKey_idx" ON "SetupBacktest"("typeKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaperTrade_setupId_key" ON "PaperTrade"("setupId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRegistry_name_key" ON "JobRegistry"("name");

