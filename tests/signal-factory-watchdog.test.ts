import { TEST_DB } from "./sf-watchdog-env";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "@/modules/exchanges/types";

/**
 * Watchdog test — a FUTURES config must probe the FUTURES contract universe
 * (perp source), not the spot Pair table. Regression guard for the fix where
 * pairFilter (spot) was used for every config.
 */

const candleCalls: string[] = [];
const tickerCalls: string[] = [];

const freshCandles = (): Candle[] => {
  const now = Date.now();
  return [0, 1, 2].map((i) => ({
    time: now - i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
};

vi.mock("@/modules/exchanges/registry", () => ({
  publicAdapter: () => ({
    getTicker: vi.fn(async (symbol: string) => {
      tickerCalls.push(symbol);
      return { symbol, last: 100, ts: Date.now() };
    }),
    getCandles: vi.fn(async (symbol: string) => {
      candleCalls.push(symbol);
      return freshCandles();
    }),
    getOrderBook: vi.fn(async () => ({ bids: [[100, 1]], asks: [[101, 1]], ts: Date.now() })),
  }),
  adapterForUser: vi.fn(),
}));

vi.mock("@/modules/scalping/source", () => ({
  dataSourceFor: (exchange: string, marketType?: string) => {
    if (exchange === "KUCOIN" && marketType === "PERPETUAL") {
      return {
        exchange: "KUCOIN",
        marketType: "PERPETUAL",
        getMarketStats: async () => [
          { symbol: "XBTUSDTM", quoteCurrency: "USDT", volumeQuote24h: 9e6, isClosed: false, ts: Date.now() },
          { symbol: "ETHUSDTM", quoteCurrency: "USDT", volumeQuote24h: 8e6, isClosed: false, ts: Date.now() },
          { symbol: "DOGEUSDTM", quoteCurrency: "USDT", volumeQuote24h: 1e3, isClosed: false, ts: Date.now() },
        ],
      };
    }
    return null;
  },
}));

let prisma: Awaited<typeof import("@/infrastructure/database/prisma")>["prisma"];
let runDataFreshnessWatchdog: Awaited<typeof import("@/modules/signal-factory/watchdog")>["runDataFreshnessWatchdog"];
let candidateSymbols: Awaited<typeof import("@/modules/signal-factory/setups")>["candidateSymbols"];

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const dir = path.join(process.cwd(), "prisma", "migrations");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(TEST_DB);
  for (const m of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()) {
    db.exec(fs.readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
  }
  db.close();
  ({ prisma } = await import("@/infrastructure/database/prisma"));
  ({ runDataFreshnessWatchdog } = await import("@/modules/signal-factory/watchdog"));
  ({ candidateSymbols } = await import("@/modules/signal-factory/setups"));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("futures candidate symbols", () => {
  it("returns perp contracts filtered by quote + volume floor", async () => {
    const out = await candidateSymbols({ exchange: "KUCOIN", marketType: "FUTURES", quote: "USDT", minVolume24h: 5e6 });
    expect(out).toEqual(["XBTUSDTM", "ETHUSDTM"]);
  });
});

describe("data-freshness watchdog on FUTURES", () => {
  it("probes the futures contract universe, not spot pairs", async () => {
    const user = await prisma.user.create({
      data: { username: "sffut", passwordHash: "x", referralCode: "SFF" },
    });
    await prisma.signalMakerConfig.create({
      data: { userId: user.id, exchange: "KUCOIN", marketType: "FUTURES" },
    });

    candleCalls.length = 0;
    tickerCalls.length = 0;
    await runDataFreshnessWatchdog();

    expect(tickerCalls[0]).toBe("XBTUSDTM");
    expect(candleCalls.length).toBeGreaterThan(0);
    expect(candleCalls.every((s) => s.endsWith("USDTM"))).toBe(true);
    expect(candleCalls.some((s) => s.includes("-"))).toBe(false); // no spot symbols
    expect(await prisma.incident.count()).toBe(0);
  });
});
