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
 * NobitexAdapter — implements ExchangeAdapter against the Nobitex REST API.
 * Docs: https://apidocs.nobitex.ir/
 *
 * Auth: `Authorization: Token {token}` — Nobitex issues a per-user API
 * token (created in Nobitex panel with trade-only permission).
 * The stored apiSecret is kept encrypted and unused by this adapter —
 * it exists so the account model stays compatible with future
 * HMAC-based exchanges (Binance, Bybit).
 */

const DEFAULT_BASE = "https://testnetapiv2.nobitex.ir";
const DEFAULT_PUBLIC_BASE = "https://apiv2.nobitex.ir";

const TIMEFRAME_TO_RESOLUTION: Record<string, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};

/** Timeframes Nobitex rejects ("Invalid resolution!") — built by aggregating a finer resolution. */
const DERIVED_TIMEFRAMES: Record<string, { base: string; bucketMs: number; ratio: number }> = {
  "3m": { base: "1m", bucketMs: 180_000, ratio: 3 },
};

export interface NobitexCredentials {
  apiKey: string;
  apiSecret?: string;
  userId?: string;
  workerId?: string;
}

export class NobitexAdapter implements ExchangeAdapter {
  readonly name = "nobitex";
  private baseUrl: string;
  /** Public market-data base — testnet returns flat/synthetic candles, so public endpoints default to mainnet (no auth needed). */
  private publicUrl: string;
  private breaker = new CircuitBreaker(5, 60_000);
  private token: string;
  private userId?: string;
  private workerId?: string;

  constructor(creds: NobitexCredentials, baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.NOBITEX_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
    this.publicUrl = (
      process.env.NOBITEX_PUBLIC_BASE_URL ||
      (this.baseUrl.includes("testnet") ? DEFAULT_PUBLIC_BASE : this.baseUrl)
    ).replace(/\/$/, "");
    this.token = creds.apiKey;
    this.userId = creds.userId;
    this.workerId = creds.workerId;
  }

  // ---- HTTP plumbing ---------------------------------------------------

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { params?: Record<string, string>; body?: Record<string, unknown>; auth?: boolean; public?: boolean } = {},
  ): Promise<T> {
    await rateLimit({
      exchange: this.name,
      endpoint: path,
      userId: this.userId,
      workerId: this.workerId,
    });

    return this.breaker.exec(async () => {
      const url = new URL((opts.public ? this.publicUrl : this.baseUrl) + path);
      if (opts.params) for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);

      const headers: Record<string, string> = {};
      if (opts.auth) headers["Authorization"] = `Token ${this.token}`;
      let body: string | undefined;
      if (opts.body) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }

      const res = await fetch(url, { method, headers, body });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* non-JSON body */
      }

      if (!res.ok) {
        logger.warn("nobitex api error", { module: "nobitex", status: res.status, path });
        throw mapNobitexError(res.status, json);
      }
      if (json.status === "failed" || json.status === "error") {
        throw mapNobitexError(res.status, json);
      }
      return json as T;
    });
  }

  private toPair(symbol: string): { src: string; dst: string } {
    // symbols are stored as e.g. BTCIRT; split on known quote suffixes
    const quotes = ["IRT", "USDT"];
    const upper = symbol.toUpperCase();
    for (const q of quotes) {
      if (upper.endsWith(q)) return { src: upper.slice(0, -q.length), dst: q };
    }
    return { src: upper, dst: "IRT" };
  }

  // ---- Public market data ----------------------------------------------

  async getMarkets(): Promise<Market[]> {
    const data = await this.request<{ stats?: Record<string, Record<string, string>> }>(
      "GET",
      "/market/stats",
      { params: { dstCurrency: "irt,usdt" }, public: true },
    );
    const markets: Market[] = [];
    for (const [pair, s] of Object.entries(data.stats ?? {})) {
      const [base, quote] = pair.split("-");
      if (!base || !quote) continue;
      markets.push({
        symbol: `${base.toUpperCase()}${quote.toUpperCase()}`,
        baseCurrency: base.toUpperCase(),
        quoteCurrency: quote.toUpperCase(),
        amountPrecision: 8,
        pricePrecision: quote.toUpperCase() === "IRT" ? 0 : 2,
        active: !s.isClosed,
        raw: s,
      });
    }
    return markets;
  }

  async getMarketInfo(symbol: string): Promise<MarketInfo> {
    const { src, dst } = this.toPair(symbol);
    const data = await this.request<{ stats?: Record<string, Record<string, string>> }>(
      "GET",
      "/market/stats",
      { params: { srcCurrency: src.toLowerCase(), dstCurrency: dst.toLowerCase() }, public: true },
    );
    const stats = data.stats?.[`${src.toLowerCase()}-${dst.toLowerCase()}`];
    return {
      symbol: symbol.toUpperCase(),
      baseCurrency: src.toUpperCase(),
      quoteCurrency: dst.toUpperCase(),
      amountPrecision: 8,
      pricePrecision: dst.toUpperCase() === "IRT" ? 0 : 2,
      active: !stats?.isClosed,
      stats,
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const info = await this.getMarketInfo(symbol);
    const s = (info.stats ?? {}) as Record<string, string>;
    return {
      symbol: symbol.toUpperCase(),
      last: Number(s.latest ?? 0),
      bid: Number(s.bestBuy ?? 0),
      ask: Number(s.bestSell ?? 0),
      high24h: Number(s.dayHigh ?? 0),
      low24h: Number(s.dayLow ?? 0),
      volume24h: Number(s.dayVolume ?? 0),
      change24hPct: Number(s.dayChange ?? 0),
      ts: Date.now(),
    };
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/v3/orderbook/${symbol.toUpperCase()}`,
      { public: true },
    );
    return normalizeOrderBook(data, symbol);
  }

  async getCandles(symbol: string, timeframe: string, since?: number, limit = 500, until?: number): Promise<Candle[]> {
    const derived = DERIVED_TIMEFRAMES[timeframe];
    if (derived) {
      const alignedSince = since !== undefined ? Math.floor(since / derived.bucketMs) * derived.bucketMs : undefined;
      const base = await this.getCandles(symbol, derived.base, alignedSince, limit * derived.ratio, until);
      return aggregateCandles(base, derived.bucketMs);
    }
    const resolution = TIMEFRAME_TO_RESOLUTION[timeframe] ?? "60";
    const resMin = resolution === "D" ? 1440 : Number(resolution);
    const resSec = resMin * 60;
    const toCap = Math.min(until ?? Date.now(), Date.now());
    const to0 = Math.floor(toCap / 1000);
    const from = since ? Math.floor(since / 1000) : to0 - resSec * limit;

    // Nobitex returns at most ~500 candles per call (the latest within [from,to]) —
    // page backwards until `from` is covered or the exchange has no more data.
    const seen = new Set<number>();
    const out: Candle[] = [];
    let to = to0;
    const maxPages = Math.min(60, Math.ceil(limit / 450) + 2);
    for (let page = 0; page < maxPages; page++) {
      const data = await this.request<{
        s: string;
        t?: number[];
        o?: number[];
        h?: number[];
        l?: number[];
        c?: number[];
        v?: number[];
      }>("GET", "/market/udf/history", {
        public: true,
        params: {
          symbol: symbol.toUpperCase(),
          resolution,
          from: String(from),
          to: String(to),
        },
      });
      if (data.s !== "ok" || !data.t?.length) break;
      let earliest = Infinity;
      for (let i = 0; i < data.t.length; i++) {
        const ms = data.t[i] * 1000;
        if (seen.has(ms)) continue;
        seen.add(ms);
        earliest = Math.min(earliest, ms);
        out.push({
          time: ms,
          open: Number(data.o?.[i] ?? 0),
          high: Number(data.h?.[i] ?? 0),
          low: Number(data.l?.[i] ?? 0),
          close: Number(data.c?.[i] ?? 0),
          volume: Number(data.v?.[i] ?? 0),
        });
      }
      if (earliest <= from * 1000 || earliest === Infinity || out.length >= limit) break;
      to = Math.floor(earliest / 1000) - resSec; // step one candle before the oldest we have
    }
    return out.sort((a, b) => a.time - b.time);
  }

  // ---- Private endpoints -------------------------------------------------

  async getBalance(): Promise<Balance[]> {
    const data = await this.request<{ wallets?: { currency: string; balance: string; blockedBalance?: string }[] }>(
      "GET",
      "/users/wallets/list",
      { auth: true },
    );
    return (data.wallets ?? []).map((w) => ({
      currency: w.currency.toUpperCase(),
      free: Number(w.balance),
      locked: Number(w.blockedBalance ?? 0),
      total: Number(w.balance) + Number(w.blockedBalance ?? 0),
    }));
  }

  async validateCredentials(): Promise<boolean> {
    try {
      const data = await this.request<{ status?: string; profile?: unknown }>(
        "GET",
        "/users/profile",
        { auth: true },
      );
      return data.status === "ok" || !!data.profile;
    } catch {
      return false;
    }
  }

  async createOrder(params: OrderParams): Promise<ExchangeOrder> {
    const { src, dst } = this.toPair(params.symbol);
    const body: Record<string, unknown> = {
      type: params.side,
      execution: params.type,
      srcCurrency: src.toLowerCase(),
      dstCurrency: dst.toLowerCase(),
      amount: String(params.amount),
    };
    if (params.type === "limit" && params.price !== undefined) body.price = String(params.price);
    if (params.clientOrderId) body.clientOrderId = params.clientOrderId;

    const data = await this.request<{ status: string; order?: Record<string, unknown> }>(
      "POST",
      "/market/orders/add",
      { auth: true, body },
    );
    if (!data.order) throw new AppError("ORDER_REJECTED", 502);
    return normalizeOrder(data.order, params.symbol);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.request("POST", "/market/orders/update-status", {
        auth: true,
        body: { order: Number(orderId), status: "canceled" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async getOrder(orderId: string): Promise<ExchangeOrder> {
    const data = await this.request<{ orders?: Record<string, unknown>[] }>(
      "POST",
      "/market/orders/list",
      { auth: true, body: { id: Number(orderId) } },
    );
    const o = data.orders?.[0];
    if (!o) throw new AppError("NOT_FOUND", 404);
    return normalizeOrder(o, String(o.symbol ?? ""));
  }

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const body: Record<string, unknown> = { status: "active" };
    if (symbol) body.details = 1;
    const data = await this.request<{ orders?: Record<string, unknown>[] }>(
      "POST",
      "/market/orders/list",
      { auth: true, body },
    );
    return (data.orders ?? [])
      .filter((o) => !symbol || String(o.symbol ?? "").toUpperCase() === symbol.toUpperCase())
      .map((o) => normalizeOrder(o, String(o.symbol ?? "")));
  }

  async getTradeHistory(symbol?: string): Promise<ExchangeTrade[]> {
    const data = await this.request<{ trades?: Record<string, unknown>[] }>(
      "POST",
      "/market/trades/list",
      { auth: true, body: symbol ? { symbol } : {} },
    );
    return (data.trades ?? []).map((t) => ({
      id: String(t.id ?? ""),
      orderId: t.orderId ? String(t.orderId) : undefined,
      symbol: String(t.symbol ?? symbol ?? "").toUpperCase(),
      side: (String(t.type ?? "buy") === "sell" ? "sell" : "buy") as "buy" | "sell",
      price: Number(t.price ?? 0),
      amount: Number(t.volume ?? t.amount ?? 0),
      fee: Number(t.fee ?? 0),
      ts: Date.parse(String(t.time ?? "")) || Date.now(),
    }));
  }

  // ---- Margin / futures ------------------------------------------------
  // Docs: /margin/orders/add (leverage, buy=long sell=short),
  //       /positions/list, /positions/{id}/close

  async createFuturesOrder(params: FuturesOrderParams): Promise<ExchangeOrder> {
    const { src, dst } = this.toPair(params.symbol);
    const body: Record<string, unknown> = {
      type: params.side,
      execution: params.type,
      srcCurrency: src.toLowerCase(),
      dstCurrency: dst.toLowerCase(),
      amount: String(params.amount),
      leverage: String(params.leverage),
    };
    // margin orders are limit by default — market orders still carry a
    // reference price on nobitex, so always send one when known
    const price = params.price;
    if (price !== undefined) body.price = String(price);
    if (params.clientOrderId) body.clientOrderId = params.clientOrderId;

    const data = await this.request<{ status: string; order?: Record<string, unknown> }>(
      "POST",
      "/margin/orders/add",
      { auth: true, body },
    );
    if (!data.order) throw new AppError("ORDER_REJECTED", 502);
    return normalizeOrder(data.order, params.symbol);
  }

  async getOpenPositions(symbol?: string): Promise<ExchangePosition[]> {
    const data = await this.request<{ positions?: Record<string, unknown>[] }>(
      "POST",
      "/positions/list",
      { auth: true, body: { status: "active" } },
    );
    return (data.positions ?? [])
      .map((p) => normalizePosition(p))
      .filter((p) => !symbol || p.symbol === symbol.toUpperCase());
  }

  async closePosition(positionId: string): Promise<boolean> {
    try {
      await this.request("POST", `/positions/${positionId}/close`, { auth: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** /positions/list row → normalized position. Nobitex type: "Buy" = long, "Sell" = short. */
function normalizePosition(p: Record<string, unknown>): ExchangePosition {
  const src = String(p.srcCurrency ?? "").toUpperCase();
  const dst = String(p.dstCurrency ?? "").toUpperCase();
  const sideRaw = String(p.type ?? p.side ?? "buy").toLowerCase();
  return {
    id: String(p.id ?? p.positionId ?? ""),
    symbol: src && dst ? `${src}${dst}` : "",
    side: sideRaw === "sell" ? "SHORT" : "LONG",
    leverage: Number(p.leverage ?? 1),
    entryPrice: Number(p.entryPrice ?? p.averagePrice ?? p.avgPrice ?? 0),
    amount: Number(p.amount ?? p.volume ?? 0),
    margin: Number(p.margin ?? p.collateral ?? 0),
    liquidationPrice: p.liquidationPrice !== undefined ? Number(p.liquidationPrice) : undefined,
    raw: p,
  };
}

/** /v3/orderbook returns a flat {asks,bids} body (older docs show it keyed by symbol — handle both). */
export function normalizeOrderBook(data: Record<string, unknown>, symbol: string): OrderBook {
  const raw = (data[symbol.toUpperCase()] ?? data) as {
    asks?: [string, string][];
    bids?: [string, string][];
  };
  return {
    bids: (raw.bids ?? []).map(([p, a]) => [Number(p), Number(a)]),
    asks: (raw.asks ?? []).map(([p, a]) => [Number(p), Number(a)]),
    ts: Date.now(),
  };
}

/** Aggregate fine candles into fixed-size buckets (e.g. 1m → 3m). Input must be time-ascending. */
function aggregateCandles(candles: Candle[], bucketMs: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const key = Math.floor(c.time / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()];
}

function normalizeOrder(o: Record<string, unknown>, fallbackSymbol: string): ExchangeOrder {
  const statusMap: Record<string, ExchangeOrder["status"]> = {
    active: "open",
    done: "filled",
    partially: "partially_filled",
    canceled: "cancelled",
    rejected: "rejected",
  };
  const src = String(o.srcCurrency ?? "").toUpperCase();
  const dst = String(o.dstCurrency ?? "").toUpperCase();
  return {
    id: String(o.id ?? ""),
    symbol: src && dst ? `${src}${dst}` : fallbackSymbol.toUpperCase(),
    side: String(o.type ?? "buy") === "sell" ? "sell" : "buy",
    type: String(o.execution ?? "market") === "limit" ? "limit" : "market",
    amount: Number(o.amount ?? 0),
    price: o.price !== undefined ? Number(o.price) : undefined,
    filledAmount: Number(o.matchedAmount ?? 0),
    avgPrice: o.averagePrice !== undefined ? Number(o.averagePrice) : undefined,
    status: statusMap[String(o.status ?? "").toLowerCase()] ?? "pending",
    createdAt: Date.parse(String(o.created_at ?? "")) || Date.now(),
    raw: o,
  };
}

function mapNobitexError(httpStatus: number, body: Record<string, unknown>): AppError {
  const code = String(body.code ?? "");
  const msg = String(body.message ?? "");
  if (httpStatus === 429 || code === "TooManyRequests") return new AppError("NOBITEX_RATE_LIMITED", 429);
  if (/order.?size|amount|min/i.test(code + msg)) return new AppError("NOBITEX_INVALID_ORDER_SIZE", 400);
  if (/balance|insufficient/i.test(code + msg)) return new AppError("NOBITEX_INSUFFICIENT_BALANCE", 400);
  if (httpStatus === 401 || httpStatus === 403) return new AppError("EXCHANGE_CONNECTION_FAILED", 401);
  if (httpStatus >= 400) return new AppError("ORDER_REJECTED", httpStatus);
  return new AppError("UNKNOWN", 502);
}
