-- CreateTable
CREATE TABLE "WhaleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "marketType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mid" REAL NOT NULL,
    "price" REAL,
    "sizeUsd" REAL,
    "distancePct" REAL,
    "sharePct" REAL,
    "bidDepthUsd" REAL NOT NULL,
    "askDepthUsd" REAL NOT NULL,
    "imbalance" REAL NOT NULL,
    "score" REAL NOT NULL,
    "reasons" TEXT NOT NULL,
    "features" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WhaleEvent_userId_createdAt_idx" ON "WhaleEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WhaleEvent_symbol_exchange_idx" ON "WhaleEvent"("symbol", "exchange");
