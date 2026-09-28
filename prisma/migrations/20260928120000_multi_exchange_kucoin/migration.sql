-- Multi-exchange support: KuCoin credentials carry a passphrase, live strategies
-- pin their exchange, pairs are unique per (exchange, symbol), and the candle
-- cache is keyed per exchange.

ALTER TABLE "ExchangeAccount" ADD COLUMN "apiPassphraseEnc" TEXT;

ALTER TABLE "LiveStrategy" ADD COLUMN "exchange" TEXT NOT NULL DEFAULT 'NOBITEX';

ALTER TABLE "HistoricalCandle" ADD COLUMN "exchange" TEXT NOT NULL DEFAULT 'NOBITEX';
DROP INDEX "HistoricalCandle_symbol_timeframe_time_key";
CREATE UNIQUE INDEX "HistoricalCandle_exchange_symbol_timeframe_time_key" ON "HistoricalCandle"("exchange", "symbol", "timeframe", "time");

DROP INDEX "Pair_symbol_key";
CREATE UNIQUE INDEX "Pair_exchange_symbol_key" ON "Pair"("exchange", "symbol");
CREATE INDEX "Pair_symbol_idx" ON "Pair"("symbol");
