import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import type { ExchangeAdapter } from "@/modules/exchanges/types";

/**
 * Risk Engine — every order must pass ALL checks before submission.
 * A single violation → order is not sent.
 */

export interface RiskCheckInput {
  userId: string;
  liveStrategyId: string;
  symbol: string;
  side: "BUY" | "SELL";
  amount: number;           // base currency amount
  price: number;            // estimated execution price
  allocatedCapital: number; // strategy capital ceiling (quote currency)
  riskPerTradePct: number;
  maxPositionPct: number;
}

export interface RiskDecision {
  approved: boolean;
  violations: string[];
  adjustedAmount?: number;
}

export async function riskCheck(input: RiskCheckInput, adapter: ExchangeAdapter): Promise<RiskDecision> {
  const violations: string[] = [];
  const notional = input.amount * input.price;

  // 1. Capital — notional must not exceed allocated capital
  if (notional > input.allocatedCapital) violations.push("CAPITAL_EXCEEDED");

  // 2. Risk per trade — size bounded by risk %
  const maxRiskNotional = input.allocatedCapital * (input.riskPerTradePct / 100) * 10;
  if (notional > maxRiskNotional && input.side === "BUY") violations.push("RISK_PER_TRADE_EXCEEDED");

  // 3. Maximum position — pct of allocated capital
  const maxPosition = input.allocatedCapital * (input.maxPositionPct / 100);
  if (notional > maxPosition && input.side === "BUY") violations.push("MAX_POSITION_EXCEEDED");

  // 4. Available balance on the exchange
  try {
    const balances = await adapter.getBalance();
    if (input.side === "BUY") {
      const quote = balances.find((b) => b.currency === "IRT" || b.currency === "USDT");
      if (quote && quote.free < notional) violations.push("INSUFFICIENT_EXCHANGE_BALANCE");
    } else {
      const base = input.symbol.replace(/IRT|USDT$/, "");
      const b = balances.find((x) => x.currency === base);
      if (b && b.free < input.amount) violations.push("INSUFFICIENT_EXCHANGE_BALANCE");
    }
  } catch {
    violations.push("BALANCE_CHECK_FAILED");
  }

  // 5-6. Pair min/max
  const pair = await prisma.pair.findUnique({ where: { symbol: input.symbol } });
  if (pair) {
    if (pair.minAmount && input.amount < pair.minAmount) violations.push("BELOW_PAIR_MIN");
    if (pair.maxAmount && input.amount > pair.maxAmount) violations.push("ABOVE_PAIR_MAX");
    if (!pair.active) violations.push("PAIR_INACTIVE");
  }

  // 7-8. SL/TP sanity — configured on the version, checked by caller

  // 9. Existing open position for this strategy+symbol
  const openTrade = await prisma.trade.findFirst({
    where: { liveStrategyId: input.liveStrategyId, symbol: input.symbol, status: "OPEN" },
  });
  if (openTrade && input.side === "BUY") violations.push("EXISTING_POSITION");

  // 10. Existing open order for this strategy+symbol
  const openOrder = await prisma.order.findFirst({
    where: {
      liveStrategyId: input.liveStrategyId,
      symbol: input.symbol,
      status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
    },
  });
  if (openOrder) violations.push("EXISTING_ORDER");

  // 11. Daily limits — max 50 trades/day per strategy (system setting could override)
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.trade.count({
    where: { liveStrategyId: input.liveStrategyId, openedAt: { gte: dayStart } },
  });
  if (todayTrades >= 50) violations.push("DAILY_LIMIT_REACHED");

  return { approved: violations.length === 0, violations };
}

/** Throwing variant for order paths. */
export async function enforceRisk(input: RiskCheckInput, adapter: ExchangeAdapter): Promise<void> {
  const decision = await riskCheck(input, adapter);
  if (!decision.approved) {
    throw new AppError("RISK_VIOLATION", 422, { violations: decision.violations });
  }
}
