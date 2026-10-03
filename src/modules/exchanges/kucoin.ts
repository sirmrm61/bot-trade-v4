import crypto from "node:crypto";
import {
  type ExchangeAdapter,
  type Market,
  type MarketInfo,
  type Balance,
  type Ticker,
  type OrderBook,
  type Candle,
  type OrderParams,
  type FuturesOrderParams,
  type ExchangeOrder,
  type ExchangePosition,
  type ExchangeTrade,
} from "./types";
import { rateLimit } from "./rate-limiter";
import { CircuitBreaker } from "./circuit-breaker";
import { AppError } from "@/shared/errors";
import { logger } from "@/infrastructure/logging/logger";

/**
 * KucoinAdapter — ExchangeAdapter over the KuCoin REST API.
 * Docs: https://www.kucoin.com/docs-new (Classic REST)
 *
 * Hosts: spot → api.kucoin.com · futures → api-futures.kucoin.com
 * Auth: KC-API-KEY + KC-API-SIGN(base64 HMAC-SHA256(ts+method+path+body))
 *       + KC-API-PASSPHRASE signed HMAC(passphrase, secret) with KEY-VERSION:2.
 * Symbols are exchange-native dashed form: "BTC-USDT".
 */

const DEFAULT_BASE = "https://api.kucoin.com";
const DEFAULT_FUTURES_BASE = "https://api-futures.kucoin.com";

const TIMEFRAME_TO_TYPE: Record<string, string> = {
  "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min",
  "1h": "1hour", "4h": "4hour", "1d": "1day",
};
const FUTURES_GRANULARITY_MIN: Record<string, number> = {
  "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440,
};

export interface KucoinCredentials {
  apiKey: string;
  apiSecret?: string;
  apiPassphrase?: string;
  userId?: string;
  workerId?: string;
}

export class KucoinAdapter implements ExchangeAdapter {
  readonly name = "kucoin";
  private baseUrl: string;
  private futuresUrl: string;
  private breaker = new CircuitBreaker(5, 60_000);
  private apiKey: string;
  private apiSecret: string;
  private apiPassphrase: string;
  private userId?: string;
  private workerId?: string;

  constructor(creds: KucoinCredentials, baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.KUCOIN_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
    this.futuresUrl = (process.env.KUCOIN_FUTURES_BASE_URL || DEFAULT_FUTURES_BASE).replace(/\/$/, "");
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret ?? "";
    this.apiPassphrase = creds.apiPassphrase ?? "";
    this.userId = creds.userId;
    this.workerId = creds.workerId;
  }

  // ---- HTTP plumbing ---------------------------------------------------

  private sign(ts: number, method: string, pathWithQuery: string, body: string): Record<string, string> {
    const sign = crypto
      .createHmac("sha256", this.apiSecret)
      .update(`${ts}${method}${pathWithQuery}${body}`)
      .digest("base64");
    const passphrase = crypto
      .createHmac("sha256", this.apiSecret)
      .update(this.apiPassphrase)
      .digest("base64");
    return {
      "KC-API-KEY": this.apiKey,
      "KC-API-SIGN": sign,
      "KC-API-TIMESTAMP": String(ts),
      "KC-API-PASSPHRASE": passphrase,
      "KC-API-KEY-VERSION": "2",
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { params?: Record<string, string>; body?: Record<string, unknown>; auth?: boolean; futures?: boolean } = {},
  ): Promise<T> {
    await rateLimit({
      exchange: this.name,
      endpoint: path,
      userId: this.userId,
      workerId: this.workerId,
    });

    return this.breaker.exec(async () => {
      const base = opts.futures ? this.futuresUrl : this.baseUrl;
      const url = new URL(base + path);
      if (opts.params) for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);
      const pathWithQuery = url.pathname + url.search;
      const body = opts.body ? JSON.stringify(opts.body) : "";

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.auth) Object.assign(headers, this.sign(Date.now(), method, pathWithQuery, body));

      const res = await fetch(url, { method, headers, body: body || undefined });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* non-JSON body */
      }

      const code = String(json.code ?? "");
      if (!res.ok || (code && code !== "200000")) {
        logger.warn("kucoin api error", { module: "kucoin", status: res.status, path, code });
        throw mapKucoinError(res.status, code, String(json.msg ?? ""));
      }
      return json as T;
    });
  }

  /** Public GET escape hatch for endpoints not on the ExchangeAdapter contract
   *  (e.g. market/allTickers bulk stats used by the scalping scanner). */
  async publicGet<T>(path: string, futures = false): Promise<T> {
    return this.request<T>("GET", path, { futures });
  }

  // ---- Public market data ----------------------------------------------

  async getMarkets(): Promise<Market[]> {
    const data = await this.request<{ data?: Record<string, unknown>[] }>("GET", "/api/v2/symbols");
    return (data.data ?? []).map((s) => ({
      symbol: String(s.symbol ?? ""),
      baseCurrency: String(s.baseCurrency ?? "").toUpperCase(),
      quoteCurrency: String(s.quoteCurrency ?? "").toUpperCase(),
      minAmount: num(s.baseMinSize) || undefined,
      maxAmount: num(s.baseMaxSize) || undefined,
      // quoteMinSize (min order funds) stays inside `raw` — it isn't a price limit
      amountPrecision: decimals(s.baseIncrement),
      pricePrecision: decimals(s.priceIncrement),
      active: s.enableTrading === true,
      raw: s,
    })).filter((m) => m.symbol);
  }

  /** Spot markets are dashed (BTC-USDT); futures contracts never are (ZECUSDTM). */
  private isFuturesSymbol(symbol: string): boolean {
    return !symbol.toUpperCase().includes("-");
  }

  async getMarketInfo(symbol: string): Promise<MarketInfo> {
    if (this.isFuturesSymbol(symbol)) {
      const c = await this.contract(symbol);
      return {
        symbol: symbol.toUpperCase(),
        baseCurrency: String(c.baseCurrency ?? c.rootSymbol ?? ""),
        quoteCurrency: String(c.quoteCurrency ?? "USDT"),
        amountPrecision: decimals(c.lotSize ?? c.multiplier),
        pricePrecision: decimals(c.tickSize ?? c.indexPriceTickSize),
        active: c.status === "Open" || c.status === undefined,
        stats: c,
      };
    }
    const markets = await this.getMarkets();
    const m = markets.find((x) => x.symbol === symbol.toUpperCase());
    const stats = await this.request<{ data?: Record<string, unknown> }>(
      "GET", "/api/v1/market/stats", { params: { symbol: symbol.toUpperCase() } },
    ).catch(() => ({ data: undefined }));
    return {
      symbol: symbol.toUpperCase(),
      baseCurrency: m?.baseCurrency ?? symbol.split("-")[0] ?? "",
      quoteCurrency: m?.quoteCurrency ?? symbol.split("-")[1] ?? "",
      amountPrecision: m?.amountPrecision ?? 8,
      pricePrecision: m?.pricePrecision ?? 8,
      active: m?.active ?? true,
      stats: stats.data,
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    // futures contract — spot stats returns 200 with all-null data, silently
    // poisoning price reads (last=0 → division-by-zero sizing)
    if (this.isFuturesSymbol(symbol)) {
      const d = (await this.request<{ data?: Record<string, unknown> }>(
        "GET", "/api/v1/ticker", { futures: true, params: { symbol: symbol.toUpperCase() } },
      )).data ?? {};
      return {
        symbol: symbol.toUpperCase(),
        last: num(d.price),
        bid: num(d.bestBidPrice),
        ask: num(d.bestAskPrice),
        ts: num(d.ts) || Date.now(),
      };
    }
    const [stats, l1] = await Promise.all([
      this.request<{ data?: Record<string, unknown> }>(
        "GET", "/api/v1/market/stats", { params: { symbol: symbol.toUpperCase() } }),
      this.request<{ data?: Record<string, unknown> }>(
        "GET", "/api/v1/market/orderbook/level1", { params: { symbol: symbol.toUpperCase() } })
        .catch(() => ({ data: undefined })),
    ]);
    const s = stats.data ?? {};
    const o = l1.data ?? {};
    return {
      symbol: symbol.toUpperCase(),
      last: num(s.last) || num(o.price),
      bid: num(s.buy) || num(o.bestBid),
      ask: num(s.sell) || num(o.bestAsk),
      high24h: num(s.high),
      low24h: num(s.low),
      volume24h: num(s.vol),
      change24hPct: num(s.changeRate) * 100,
      ts: Date.now(),
    };
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    if (this.isFuturesSymbol(symbol)) return this.getFuturesOrderBook(symbol);
    const data = await this.request<{
      data?: { time?: number; bids?: [string, string][]; asks?: [string, string][] };
    }>("GET", "/api/v1/market/orderbook/level2_20", { params: { symbol: symbol.toUpperCase() } });
    const d = data.data ?? {};
    return {
      bids: (d.bids ?? []).map(([p, a]) => [Number(p), Number(a)]),
      asks: (d.asks ?? []).map(([p, a]) => [Number(p), Number(a)]),
      ts: d.time || Date.now(),
    };
  }

  async getCandles(symbol: string, timeframe: string, since?: number, limit = 500, until?: number): Promise<Candle[]> {
    // spot markets are always dashed (BTC-USDT); futures contracts never are
    // (ZECUSDTM) — route them to the futures kline endpoint or spot returns 400100
    if (!symbol.includes("-")) return this.getFuturesCandles(symbol, timeframe, since, limit, until);
    const type = TIMEFRAME_TO_TYPE[timeframe] ?? "1hour";
    const params: Record<string, string> = { type, symbol: symbol.toUpperCase() };
    if (since) params.startAt = String(Math.floor(since / 1000));
    if (until) params.endAt = String(Math.floor(until / 1000));
    const data = await this.request<{ data?: (string | number)[][] }>(
      "GET", "/api/v1/market/candles", { params });
    // KuCoin rows: [ts_sec, open, close, high, low, volume, turnover] — newest first
    return (data.data ?? [])
      .map((r) => ({
        time: Number(r[0]) * 1000,
        open: Number(r[1]),
        close: Number(r[2]),
        high: Number(r[3]),
        low: Number(r[4]),
        volume: Number(r[5]),
      }))
      .filter((c) => (!since || c.time >= since) && (!until || c.time <= until))
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }

  // ---- Private endpoints -------------------------------------------------

  async getBalance(): Promise<Balance[]> {
    const data = await this.request<{ data?: Record<string, unknown>[] }>(
      "GET", "/api/v1/accounts", { auth: true, params: { type: "trade" } });
    return (data.data ?? []).map((a) => ({
      currency: String(a.currency ?? "").toUpperCase(),
      free: num(a.available),
      locked: num(a.holds),
      total: num(a.balance),
    }));
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.request("GET", "/api/v1/accounts", { auth: true });
      return true;
    } catch {
      return false;
    }
  }

  async createOrder(params: OrderParams): Promise<ExchangeOrder> {
    const body: Record<string, unknown> = {
      clientOid: params.clientOrderId ?? crypto.randomUUID(),
      side: params.side,
      symbol: params.symbol.toUpperCase(),
      type: params.type,
      size: String(params.amount),
    };
    if (params.type === "limit" && params.price !== undefined) body.price = String(params.price);
    const data = await this.request<{ data?: { orderId?: string } }>(
      "POST", "/api/v1/orders", { auth: true, body });
    if (!data.data?.orderId) throw new AppError("ORDER_REJECTED", 502);
    return {
      id: data.data.orderId, symbol: params.symbol.toUpperCase(), side: params.side,
      type: params.type, amount: params.amount, price: params.price,
      filledAmount: 0, status: "open", createdAt: Date.now(),
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/api/v1/orders/${orderId}`, { auth: true });
      return true;
    } catch {
      return false;
    }
  }

  async getOrder(orderId: string): Promise<ExchangeOrder> {
    const data = await this.request<{ data?: Record<string, unknown> }>(
      "GET", `/api/v1/orders/${orderId}`, { auth: true });
    const o = data.data;
    if (!o) throw new AppError("NOT_FOUND", 404);
    return normalizeOrder(o);
  }

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const params: Record<string, string> = { status: "active" };
    if (symbol) params.symbol = symbol.toUpperCase();
    const data = await this.request<{ data?: { items?: Record<string, unknown>[] } }>(
      "GET", "/api/v1/orders", { auth: true, params });
    return (data.data?.items ?? []).map(normalizeOrder);
  }

  async getTradeHistory(symbol?: string): Promise<ExchangeTrade[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    const data = await this.request<{ data?: { items?: Record<string, unknown>[] } }>(
      "GET", "/api/v1/fills", { auth: true, params });
    return (data.data?.items ?? []).map((f) => ({
      id: String(f.tradeId ?? f.id ?? ""),
      orderId: f.orderId ? String(f.orderId) : undefined,
      symbol: String(f.symbol ?? symbol ?? "").toUpperCase(),
      side: String(f.side ?? "buy") === "sell" ? "sell" : "buy",
      price: num(f.price),
      amount: num(f.size),
      fee: num(f.fee),
      ts: Number(f.createdAt ?? 0) || Date.now(),
    }));
  }

  // ---- Futures (api-futures.kucoin.com) — real perpetuals ----------------

  /** All active perpetual contracts — public; includes funding, OI, mark, fees. */
  async listFuturesContracts(): Promise<Record<string, unknown>[]> {
    const data = await this.request<{ data?: Record<string, unknown>[] }>(
      "GET", "/api/v1/contracts/active", { futures: true });
    return data.data ?? [];
  }

  /** Futures order book snapshot (public). */
  async getFuturesOrderBook(symbol: string): Promise<OrderBook> {
    const data = await this.request<{ data?: { ts?: number; bids?: number[][]; asks?: number[][] } }>(
      "GET", "/api/v1/level2/snapshot", { futures: true, params: { symbol: symbol.toUpperCase() } });
    const d = data.data ?? {};
    return {
      bids: (d.bids ?? []).map((l) => [Number(l[0]), Number(l[1])]),
      asks: (d.asks ?? []).map((l) => [Number(l[0]), Number(l[1])]),
      ts: d.ts ? (d.ts > 1e12 ? d.ts : d.ts * 1000) : Date.now(),
    };
  }

  /** Futures klines (public) — rows [ts_ms, open, high, low, close, volume]. */
  async getFuturesCandles(symbol: string, timeframe: string, since?: number, limit = 200, until?: number): Promise<Candle[]> {
    const gran = FUTURES_GRANULARITY_MIN[timeframe] ?? 60;
    const params: Record<string, string> = {
      granularity: String(gran),
      symbol: symbol.toUpperCase(),
      from: String(since ?? Date.now() - limit * gran * 60_000),
      to: String(until ?? Date.now()),
    };
    const data = await this.request<{ data?: (number | string)[][] }>(
      "GET", "/api/v1/kline/query", { futures: true, params });
    return (data.data ?? [])
      .map((r) => ({
        time: Number(r[0]) > 1e12 ? Number(r[0]) : Number(r[0]) * 1000,
        open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
        close: Number(r[4]), volume: Number(r[5]),
      }))
      .filter((c) => (!since || c.time >= since) && (!until || c.time <= until))
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }

  private async contract(symbol: string): Promise<Record<string, unknown>> {
    const data = await this.request<{ data?: Record<string, unknown> }>(
      "GET", `/api/v1/contracts/${symbol.toUpperCase()}`, { futures: true });
    if (!data.data) throw new AppError("NOT_FOUND", 404);
    return data.data;
  }

  async createFuturesOrder(params: FuturesOrderParams): Promise<ExchangeOrder> {
    const c = await this.contract(params.symbol);
    const multiplier = num(c.multiplier) || 1;
    const lots = Math.max(1, Math.floor(params.amount / multiplier));
    const body: Record<string, unknown> = {
      clientOid: params.clientOrderId ?? crypto.randomUUID(),
      side: params.side,
      symbol: params.symbol.toUpperCase(),
      type: params.type,
      size: lots,
      leverage: String(params.leverage),
    };
    if (params.type === "limit" && params.price !== undefined) body.price = String(params.price);
    const data = await this.request<{ data?: { orderId?: string } }>(
      "POST", "/api/v1/orders", { auth: true, futures: true, body });
    if (!data.data?.orderId) throw new AppError("ORDER_REJECTED", 502);
    return {
      id: data.data.orderId, symbol: params.symbol.toUpperCase(), side: params.side,
      type: params.type, amount: lots * multiplier, price: params.price,
      filledAmount: 0, status: "open", createdAt: Date.now(),
    };
  }

  async getOpenPositions(symbol?: string): Promise<ExchangePosition[]> {
    const data = await this.request<{ data?: Record<string, unknown>[] }>(
      "GET", "/api/v1/positions", { auth: true, futures: true });
    return (data.data ?? [])
      .map((p) => normalizeFuturesPosition(p))
      .filter((p) => !symbol || p.symbol === symbol.toUpperCase());
  }

  async closePosition(positionId: string): Promise<boolean> {
    // KuCoin futures has no position id — positionId here is the symbol;
    // close via opposite reduceOnly market order on currentQty
    const positions = await this.getOpenPositions(positionId);
    const p = positions[0];
    if (!p) return false;
    const c = await this.contract(p.symbol);
    const lots = Math.max(1, Math.round(p.amount / (num(c.multiplier) || 1)));
    try {
      await this.request("POST", "/api/v1/orders", {
        auth: true, futures: true,
        body: {
          clientOid: crypto.randomUUID(), side: p.side === "LONG" ? "sell" : "buy",
          symbol: p.symbol, type: "market", size: lots, reduceOnly: true,
        },
      });
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeOrder(o: Record<string, unknown>): ExchangeOrder {
  const isActive = o.isActive === true;
  const cancelled = o.cancelExist === true;
  const size = num(o.size);
  const deal = num(o.dealSize);
  const status: ExchangeOrder["status"] = cancelled
    ? "cancelled"
    : isActive ? (deal > 0 ? "partially_filled" : "open") : "filled";
  return {
    id: String(o.id ?? ""),
    symbol: String(o.symbol ?? "").toUpperCase(),
    side: String(o.side ?? "buy") === "sell" ? "sell" : "buy",
    type: String(o.type ?? "market") === "limit" ? "limit" : "market",
    amount: size,
    price: o.price !== undefined ? num(o.price) : undefined,
    filledAmount: deal,
    avgPrice: deal > 0 ? num(o.dealFunds) / deal : undefined,
    status,
    createdAt: Number(o.createdAt ?? 0) || Date.now(),
    raw: o,
  };
}

function normalizeFuturesPosition(p: Record<string, unknown>): ExchangePosition {
  const qty = num(p.currentQty);
  return {
    id: String(p.symbol ?? ""),
    symbol: String(p.symbol ?? "").toUpperCase(),
    side: qty < 0 ? "SHORT" : "LONG",
    leverage: num(p.realLeverage) || num(p.leverage) || 1,
    entryPrice: num(p.avgEntryPrice),
    amount: Math.abs(qty) * (num(p.multiplier) || 1),
    margin: num(p.posMargin) || num(p.margin),
    liquidationPrice: p.liquidationPrice ? num(p.liquidationPrice) : undefined,
    raw: p,
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function decimals(increment: unknown): number {
  const s = String(increment ?? "");
  if (!s.includes(".")) return s === "1" || s === "" ? 0 : 0;
  return s.replace(/0+$/, "").split(".")[1]?.length ?? 0;
}

function mapKucoinError(httpStatus: number, code: string, msg: string): AppError {
  if (httpStatus === 429 || code === "429") return new AppError("NOBITEX_RATE_LIMITED", 429);
  if (/balance|insufficient/i.test(code + msg)) return new AppError("NOBITEX_INSUFFICIENT_BALANCE", 400);
  if (httpStatus === 401 || httpStatus === 403) return new AppError("EXCHANGE_CONNECTION_FAILED", 401);
  if (httpStatus >= 400 || (code && code !== "200000")) return new AppError("ORDER_REJECTED", httpStatus >= 400 ? httpStatus : 502);
  return new AppError("UNKNOWN", 502);
}
