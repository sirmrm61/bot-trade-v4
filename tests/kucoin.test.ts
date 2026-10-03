import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { KucoinAdapter } from "@/modules/exchanges/kucoin";
import { adapterWithCredentials, publicAdapter } from "@/modules/exchanges/registry";
import { dataSourceFor, KucoinSpotDataSource, KucoinPerpDataSource } from "@/modules/scalping/source";
import { redis } from "@/infrastructure/redis/client";

// keep the rate limiter on its fast local path — no Redis in the test env
beforeAll(() => redis.disconnect());
afterAll(() => vi.unstubAllGlobals());

/** Route canned KuCoin responses by path. */
function stubFetch(map: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const key = Object.keys(map).find((k) => path.includes(k));
    const body = key !== undefined ? map[key] : { code: "404000", msg: "Not Found" };
    const status = key !== undefined ? 200 : 404;
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

describe("KucoinAdapter — public market data", () => {
  const adapter = new KucoinAdapter({ apiKey: "" });

  it("normalizes /api/v2/symbols into Market[]", async () => {
    stubFetch({
      "/api/v2/symbols": {
        code: "200000",
        data: [
          { symbol: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT", baseMinSize: "0.00001", baseMaxSize: "10000000", baseIncrement: "0.00000001", priceIncrement: "0.01", enableTrading: true },
          { symbol: "ETH-USDT", baseCurrency: "ETH", quoteCurrency: "USDT", baseIncrement: "0.0001", priceIncrement: "0.01", enableTrading: false },
        ],
      },
    });
    const markets = await adapter.getMarkets();
    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject({
      symbol: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT",
      minAmount: 0.00001, active: true,
    });
    expect(markets[1].active).toBe(false);
  });

  it("normalizes ticker bid/ask/last from market/stats + level1", async () => {
    stubFetch({
      "/api/v1/market/stats": {
        code: "200000",
        data: { last: "81250", buy: "81240", sell: "81260", high: "82000", low: "80000", vol: "1234.5", changeRate: "0.012" },
      },
      "/api/v1/market/orderbook/level1": { code: "200000", data: { price: "81250", bestBid: "81240", bestAsk: "81260" } },
    });
    const t = await adapter.getTicker("BTC-USDT");
    expect(t).toMatchObject({ symbol: "BTC-USDT", last: 81250, bid: 81240, ask: 81260, volume24h: 1234.5 });
    expect(t.change24hPct).toBeCloseTo(1.2);
  });

  it("normalizes level2_20 order book", async () => {
    stubFetch({
      "/api/v1/market/orderbook/level2_20": {
        code: "200000",
        data: { time: 1700000000000, bids: [["81240", "0.5"], ["81230", "1.2"]], asks: [["81260", "0.3"]] },
      },
    });
    const book = await adapter.getOrderBook("BTC-USDT");
    expect(book.bids).toEqual([[81240, 0.5], [81230, 1.2]]);
    expect(book.asks).toEqual([[81260, 0.3]]);
    expect(book.ts).toBe(1700000000000);
  });

  it("routes contract symbols (no dash) to the futures kline host", async () => {
    const calls = stubFetch({
      "/api/v1/kline/query": { code: "200000", data: [[1700000000000, 10, 12, 9, 11, 500, 5000]] },
      "/api/v1/market/candles": { code: "400100", msg: "Param Error" },
    });
    const candles = await adapter.getCandles("ZECUSDTM", "5m", 1700000000000 - 5 * 60_000);
    expect(calls[0].url).toContain("api-futures.kucoin.com");
    expect(calls[0].url).toContain("/api/v1/kline/query");
    expect(candles[0]).toMatchObject({ open: 10, close: 11 });
  });

  it("reorders candles oldest→newest and maps [t,o,c,h,l,vol]", async () => {
    stubFetch({
      "/api/v1/market/candles": {
        code: "200000",
        data: [
          ["1700003600", "102", "105", "106", "101", "50"],
          ["1700000000", "100", "102", "103", "99", "40"],
        ],
      },
    });
    const candles = await adapter.getCandles("BTC-USDT", "1h");
    expect(candles.map((c) => c.time)).toEqual([1700000000000, 1700003600000]);
    expect(candles[0]).toMatchObject({ open: 100, close: 102, high: 103, low: 99, volume: 40 });
    expect(candles[1]).toMatchObject({ open: 102, close: 105 });
  });
});

describe("KucoinAdapter — signed private requests", () => {
  it("sends KC-API-* headers with the documented HMAC signature", async () => {
    const calls = stubFetch({
      "/api/v1/accounts": { code: "200000", data: [] },
    });
    const a = new KucoinAdapter({ apiKey: "key123", apiSecret: "secretABC", apiPassphrase: "passXYZ" });
    const ok = await a.validateCredentials();
    expect(ok).toBe(true);

    const { init } = calls[0];
    const h = (init?.headers ?? {}) as Record<string, string>;
    const ts = Number(h["KC-API-TIMESTAMP"]);
    const url = new URL(calls[0].url);
    const expectedSign = crypto
      .createHmac("sha256", "secretABC")
      .update(`${ts}GET${url.pathname}${url.search}`)
      .digest("base64");
    const expectedPass = crypto
      .createHmac("sha256", "secretABC")
      .update("passXYZ")
      .digest("base64");
    expect(h["KC-API-KEY"]).toBe("key123");
    expect(h["KC-API-SIGN"]).toBe(expectedSign);
    expect(h["KC-API-PASSPHRASE"]).toBe(expectedPass);
    expect(h["KC-API-KEY-VERSION"]).toBe("2");
  });

  it("returns false instead of throwing on bad credentials", async () => {
    stubFetch({}); // everything 404s
    const a = new KucoinAdapter({ apiKey: "bad", apiSecret: "bad", apiPassphrase: "bad" });
    expect(await a.validateCredentials()).toBe(false);
  });

  it("normalizes balances from /api/v1/accounts", async () => {
    stubFetch({
      "/api/v1/accounts": {
        code: "200000",
        data: [
          { currency: "BTC", available: "0.5", holds: "0.1", balance: "0.6" },
          { currency: "USDT", available: "1000", holds: "0", balance: "1000" },
        ],
      },
    });
    const a = new KucoinAdapter({ apiKey: "k", apiSecret: "s", apiPassphrase: "p" });
    const bals = await a.getBalance();
    expect(bals).toEqual([
      { currency: "BTC", free: 0.5, locked: 0.1, total: 0.6 },
      { currency: "USDT", free: 1000, locked: 0, total: 1000 },
    ]);
  });
});

describe("KucoinAdapter — futures (perpetual)", () => {
  const adapter = new KucoinAdapter({ apiKey: "" });

  it("lists active contracts with funding/OI/mark fields", async () => {
    stubFetch({
      "/api/v1/contracts/active": {
        code: "200000",
        data: [{
          symbol: "XBTUSDTM", baseCurrency: "XBT", quoteCurrency: "USDT",
          markPrice: 81200, indexPrice: 81195, lastTradePrice: 81210,
          fundingFeeRate: 0.0001, predictedFundingFeeRate: 0.00012,
          nextFundingRateTime: 1700032000000, openInterest: 15234,
          turnoverOf24h: 9.5e9, makerFeeRate: 0.0002, takerFeeRate: 0.0006,
          maxLeverage: 100, status: "Open",
        }],
      },
    });
    const contracts = await adapter.listFuturesContracts();
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({ symbol: "XBTUSDTM", maxLeverage: 100 });
  });

  it("normalizes futures order book and klines", async () => {
    stubFetch({
      "/api/v1/level2/snapshot": { code: "200000", data: { ts: 1700000000123, bids: [[100, 2]], asks: [[101, 1]] } },
      "/api/v1/kline/query": { code: "200000", data: [[1700000000000, 10, 12, 9, 11, 500, 5000]] },
    });
    const book = await adapter.getFuturesOrderBook("XBTUSDTM");
    expect(book.bids).toEqual([[100, 2]]);
    const candles = await adapter.getFuturesCandles("XBTUSDTM", "1h", 1700000000000 - 3600_000);
    expect(candles[0]).toMatchObject({ open: 10, high: 12, low: 9, close: 11, volume: 500 });
  });

  it("routes contract symbols to the futures ticker — spot stats returns nulls silently", async () => {
    const calls = stubFetch({
      "/api/v1/ticker": {
        code: "200000",
        data: { symbol: "ZECUSDTM", price: "41.2", bestBidPrice: "41.1", bestAskPrice: "41.3", ts: 1700000000000 },
      },
      // spot stats must NOT be hit for futures symbols — it returns 200 with all-null data
      "/api/v1/market/stats": { code: "200000", data: { last: null } },
    });
    const t = await adapter.getTicker("ZECUSDTM");
    expect(calls.some((c) => c.url.includes("api-futures.kucoin.com"))).toBe(true);
    expect(calls.some((c) => c.url.includes("api.kucoin.com/api/v1/market/stats"))).toBe(false);
    expect(t).toMatchObject({ last: 41.2, bid: 41.1, ask: 41.3 });
  });

  it("routes contract symbols to the futures order book", async () => {
    const calls = stubFetch({
      "/api/v1/level2/snapshot": { code: "200000", data: { ts: 1700000000123, bids: [[100, 2]], asks: [[101, 1]] } },
      "/api/v1/market/orderbook/level2_20": { code: "400100", msg: "symbol not exists" },
    });
    const book = await adapter.getOrderBook("ZECUSDTM");
    expect(calls[0].url).toContain("api-futures.kucoin.com");
    expect(book.bids).toEqual([[100, 2]]);
  });

  it("getMarketInfo reads the contract spec for futures symbols", async () => {
    stubFetch({
      "/api/v1/contracts/ZECUSDTM": {
        code: "200000",
        data: { symbol: "ZECUSDTM", baseCurrency: "ZEC", quoteCurrency: "USDT", multiplier: 0.01, tickSize: 0.01, status: "Open" },
      },
    });
    const info = await adapter.getMarketInfo("ZECUSDTM");
    expect(info).toMatchObject({ symbol: "ZECUSDTM", baseCurrency: "ZEC", quoteCurrency: "USDT", active: true });
  });
});

describe("exchange registry", () => {
  it("resolves KUCOIN adapters from credentials and public", () => {
    const a = adapterWithCredentials("KUCOIN", { apiKey: "k", apiSecret: "s", apiPassphrase: "p" });
    expect(a.name).toBe("kucoin");
    expect(publicAdapter("KUCOIN").name).toBe("kucoin");
    expect(publicAdapter("NOBITEX").name).toBe("nobitex");
  });

  it("rejects unknown exchanges", () => {
    expect(() => adapterWithCredentials("BINANCE", { apiKey: "k" })).toThrow();
  });
});

describe("scalping sources — KuCoin", () => {
  it("exposes spot + perpetual sources", () => {
    const spot = dataSourceFor("KUCOIN");
    const perp = dataSourceFor("KUCOIN", "PERPETUAL");
    expect(spot?.marketType).toBe("SPOT");
    expect(perp?.marketType).toBe("PERPETUAL");
    expect(dataSourceFor("BYBIT")).toBeNull();
  });

  it("maps allTickers rows incl. real per-market fees", async () => {
    stubFetch({
      "/api/v1/market/allTickers": {
        code: "200000",
        data: { ticker: [
          { symbol: "BTC-USDT", last: "81250", buy: "81240", sell: "81260", volValue: "5e8", takerFeeRate: "0.001", makerFeeRate: "0.0008", changeRate: "0.01" },
        ] },
      },
    });
    const rows = await new KucoinSpotDataSource().getMarketStats();
    expect(rows[0]).toMatchObject({
      symbol: "BTC-USDT", baseCurrency: "BTC", quoteCurrency: "USDT",
      last: 81250, bid: 81240, ask: 81260,
      volumeQuote24h: 5e8, takerFeePct: 0.1, makerFeePct: 0.08,
    });
  });

  it("maps contracts → stats + funding + OI in USD", async () => {
    stubFetch({
      "/api/v1/contracts/active": {
        code: "200000",
        data: [{
          symbol: "XBTUSDTM", baseCurrency: "XBT", quoteCurrency: "USDT",
          markPrice: 80000, indexPrice: 79990, lastTradePrice: 80010,
          fundingFeeRate: 0.0001, predictedFundingFeeRate: -0.0002,
          nextFundingRateTime: 1897118, nextFundingRateDateTime: 1700032000000,
          openInterest: 1000,
          multiplier: 0.001, turnoverOf24h: 1e9,
          makerFeeRate: 0.0002, takerFeeRate: 0.0006, status: "Open",
        }],
      },
    });
    const src = new KucoinPerpDataSource();
    const rows = await src.getMarketStats();
    expect(rows[0]).toMatchObject({
      symbol: "XBTUSDTM",
      last: 80010, markPrice: 80000, takerFeePct: 0.06, makerFeePct: 0.02,
    });
    const funding = await src.getFundingInfo("XBTUSDTM");
    expect(funding?.rate).toBeCloseTo(0.01);        // 0.0001 → 0.01%
    expect(funding?.nextRate).toBeCloseTo(-0.02);   // predicted
    expect(funding?.nextSettlementTs).toBe(1700032000000);
    // OI usd = contracts × multiplier × mark = 1000 × 0.001 × 80000
    expect(await src.getOpenInterest("XBTUSDTM")).toBe(80000);
  });
});
