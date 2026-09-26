/**
 * ExchangeAdapter contract — Strategy Engine and Order Engine only ever
 * talk to this interface, never to a concrete exchange API.
 */

export interface Market {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  minAmount?: number;
  maxAmount?: number;
  minPrice?: number;
  maxPrice?: number;
  amountPrecision: number;
  pricePrecision: number;
  active: boolean;
  raw?: unknown;
}

export interface MarketInfo extends Market {
  stats?: Record<string, unknown>;
}

export interface Balance {
  currency: string;
  free: number;
  locked: number;
  total: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  high24h?: number;
  low24h?: number;
  volume24h?: number;
  change24hPct?: number;
  ts: number;
}

export interface OrderBook {
  bids: [number, number][]; // [price, amount]
  asks: [number, number][];
  ts: number;
}

export interface Candle {
  time: number; // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface OrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  amount: number;
  price?: number;
  clientOrderId?: string; // internal idempotency id
}

export interface ExchangeOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  amount: number;
  price?: number;
  filledAmount: number;
  avgPrice?: number;
  status:
    | "pending"
    | "open"
    | "partially_filled"
    | "filled"
    | "cancelled"
    | "rejected";
  createdAt: number;
  raw?: unknown;
}

export interface ExchangeTrade {
  id: string;
  orderId?: string;
  symbol: string;
  side: OrderSide;
  price: number;
  amount: number;
  fee?: number;
  ts: number;
}

export interface ExchangeAdapter {
  readonly name: string;
  getMarkets(): Promise<Market[]>;
  getMarketInfo(symbol: string): Promise<MarketInfo>;
  getBalance(): Promise<Balance[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  getCandles(symbol: string, timeframe: string, since?: number, limit?: number, until?: number): Promise<Candle[]>;
  createOrder(params: OrderParams): Promise<ExchangeOrder>;
  cancelOrder(orderId: string, symbol?: string): Promise<boolean>;
  getOrder(orderId: string, symbol?: string): Promise<ExchangeOrder>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getTradeHistory(symbol?: string): Promise<ExchangeTrade[]>;
  validateCredentials(): Promise<boolean>;
}
