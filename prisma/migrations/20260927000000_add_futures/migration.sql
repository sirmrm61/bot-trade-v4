-- futures support: leverage + liquidation tracking on trades
ALTER TABLE "Trade" ADD COLUMN "leverage" REAL NOT NULL DEFAULT 1;
ALTER TABLE "Trade" ADD COLUMN "liquidationPrice" REAL;
ALTER TABLE "Trade" ADD COLUMN "exchangePositionId" TEXT;
