import { prisma } from "@/infrastructure/database/prisma";
import { adapterForUser } from "@/modules/exchanges/registry";
import { AppError } from "@/shared/errors";
import { logger } from "@/infrastructure/logging/logger";
import { getSetting } from "@/modules/settings/service";
import { parseJson } from "@/shared/utils";
import type { ExchangeOrder } from "@/modules/exchanges/types";

/**
 * Order Engine — the ONLY path to the exchange.
 * Flow: Signal → Risk Check → Order Builder → Exchange Validation →
 *       Submit → Track → Filled / Partial / Rejected
 *
 * UI never calls the exchange. Orders are created as PENDING rows and
 * executed by the worker via the orderQueue.
 */

export interface PlaceOrderInput {
  userId: string;
  liveStrategyId?: string;
  tradeId?: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  amount: number;
  price?: number;
  /** futures routing — submitted via /margin/orders/add instead of spot */
  futures?: { leverage: number; positionSide: "LONG" | "SHORT" };
}

/** Creates a PENDING order row + enqueues execution. Idempotent. */
export async function placeOrder(input: PlaceOrderInput, idemKey?: string) {
  const key = idemKey ?? `ord:${input.liveStrategyId ?? "manual"}:${input.symbol}:${input.side}:${Date.now()}`;
  const existing = await prisma.order.findUnique({ where: { idempotencyKey: key } });
  if (existing) return existing;

  const order = await prisma.order.create({
    data: {
      userId: input.userId,
      liveStrategyId: input.liveStrategyId,
      tradeId: input.tradeId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      amount: input.amount,
      price: input.price,
      status: "PENDING",
      idempotencyKey: key,
      ...(input.futures ? { metadata: JSON.stringify({ market: "FUTURES", ...input.futures }) } : {}),
    },
  });

  const { enqueue, QUEUE_NAMES } = await import("@/infrastructure/queue/queues");
  try {
    await enqueue(QUEUE_NAMES.ORDER, "submit", { orderId: order.id, action: "SUBMIT" });
  } catch {
    // no redis — execute inline (dev fallback)
    void submitOrder(order.id);
  }
  return order;
}

/** Worker: submits a PENDING order to the exchange. */
export async function submitOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { liveStrategy: { select: { exchange: true } } },
  });
  if (!order || order.status !== "PENDING") return order;

  const adapter = await adapterForUser(order.userId, order.liveStrategy?.exchange ?? "NOBITEX", "order-engine");
  const meta = order.metadata
    ? parseJson<{ market?: string; leverage?: number; positionSide?: "LONG" | "SHORT" }>(order.metadata, {})
    : {};

  try {
    let exOrder: ExchangeOrder;
    if (meta.market === "FUTURES") {
      if (!adapter.createFuturesOrder) throw new AppError("FUTURES_UNSUPPORTED", 400);
      exOrder = await adapter.createFuturesOrder({
        symbol: order.symbol,
        side: order.side === "BUY" ? "buy" : "sell",
        type: order.type === "LIMIT" ? "limit" : "market",
        amount: order.amount,
        price: order.price ?? undefined,
        leverage: meta.leverage ?? 1,
        positionSide: meta.positionSide ?? "LONG",
        clientOrderId: order.idempotencyKey,
      });
    } else {
      exOrder = await adapter.createOrder({
        symbol: order.symbol,
        side: order.side === "BUY" ? "buy" : "sell",
        type: order.type === "LIMIT" ? "limit" : "market",
        amount: order.amount,
        price: order.price ?? undefined,
        clientOrderId: order.idempotencyKey,
      });
    }

    return prisma.order.update({
      where: { id: order.id },
      data: {
        status: mapExchangeStatus(exOrder.status),
        exchangeOrderId: exOrder.id,
        filledAmount: exOrder.filledAmount,
        avgFillPrice: exOrder.avgPrice,
        submittedAt: new Date(),
        metadata: JSON.stringify({ ...meta, raw: exOrder.raw ?? null }),
      },
    });
  } catch (err) {
    const code = err instanceof AppError ? err.code : "ORDER_REJECTED";
    logger.error("order submit failed", { module: "trading", orderId, errorCode: code });
    return prisma.order.update({
      where: { id: order.id },
      data: { status: code === "NOBITEX_RATE_LIMITED" ? "PENDING" : "REJECTED", error: code },
    });
  }
}

const STATUS_MAP: Record<string, string> = {
  pending: "SUBMITTED",
  open: "SUBMITTED",
  partially_filled: "PARTIALLY_FILLED",
  filled: "FILLED",
  cancelled: "CANCELLED",
  rejected: "REJECTED",
};
function mapExchangeStatus(s: string): string {
  return STATUS_MAP[s] ?? "SUBMITTED";
}

/**
 * Worker: monitor an open order — poll exchange, update status.
 * Limit orders: Wait → Re-evaluate → Modify Price → resubmit,
 * bounded by LIMIT_MAX_MODIFY / LIMIT_MAX_WAIT_MIN settings.
 */
export async function monitorOrder(orderId: string): Promise<{ done: boolean; order: unknown }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { liveStrategy: { select: { exchange: true } } },
  });
  if (!order) return { done: true, order: null };
  if (!["SUBMITTED", "PARTIALLY_FILLED"].includes(order.status)) return { done: true, order };

  const adapter = await adapterForUser(order.userId, order.liveStrategy?.exchange ?? "NOBITEX", "order-monitor");
  const exOrder = await adapter.getOrder(order.exchangeOrderId!, order.symbol).catch(() => null);

  if (!exOrder) {
    return { done: false, order };
  }

  const status = mapExchangeStatus(exOrder.status);
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status,
      filledAmount: exOrder.filledAmount,
      avgFillPrice: exOrder.avgPrice,
      lastCheckedAt: new Date(),
      closedAt: ["FILLED", "CANCELLED", "REJECTED"].includes(status) ? new Date() : undefined,
    },
  });

  if (status === "FILLED" || status === "CANCELLED" || status === "REJECTED") {
    return { done: true, order: updated };
  }

  // limit order management: modify price or expire
  if (order.type === "LIMIT") {
    const maxModify = await getSetting<number>("LIMIT_MAX_MODIFY");
    const maxWaitMin = await getSetting<number>("LIMIT_MAX_WAIT_MIN");
    const ageMin = (Date.now() - order.createdAt.getTime()) / 60_000;

    if (ageMin > maxWaitMin || order.modifyCount >= maxModify) {
      await adapter.cancelOrder(order.exchangeOrderId!).catch(() => {});
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "EXPIRED", closedAt: new Date() },
      });
      return { done: true, order: updated };
    }

    // re-evaluate: nudge price toward best bid/ask
    const book = await adapter.getOrderBook(order.symbol).catch(() => null);
    if (book) {
      const target = order.side === "BUY" ? book.asks[0]?.[0] : book.bids[0]?.[0];
      if (target && target !== order.price) {
        await adapter.cancelOrder(order.exchangeOrderId!).catch(() => {});
        const newOrder = await adapter.createOrder({
          symbol: order.symbol,
          side: order.side === "BUY" ? "buy" : "sell",
          type: "limit",
          amount: order.amount - order.filledAmount,
          price: target,
          clientOrderId: `${order.idempotencyKey}:m${order.modifyCount + 1}`,
        }).catch(() => null);
        if (newOrder) {
          await prisma.order.update({
            where: { id: order.id },
            data: { exchangeOrderId: newOrder.id, price: target, modifyCount: { increment: 1 } },
          });
        }
      }
    }
  }
  return { done: false, order: updated };
}

export async function cancelOrder(orderId: string, userId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: { liveStrategy: { select: { exchange: true } } },
  });
  if (!order) throw new AppError("NOT_FOUND", 404);
  if (order.exchangeOrderId) {
    const adapter = await adapterForUser(userId, order.liveStrategy?.exchange ?? "NOBITEX");
    await adapter.cancelOrder(order.exchangeOrderId, order.symbol).catch(() => {});
  }
  return prisma.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED", closedAt: new Date() },
  });
}
