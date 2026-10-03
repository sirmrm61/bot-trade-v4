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
  /** FUTURES → notional is the posted margin; shorts skip the base-balance check */
  market?: "SPOT" | "FUTURES";
  /** exchange the symbol belongs to — defaults to NOBITEX */
  exchange?: string;
}

export interface RiskDecision {
  approved: boolean;
  violations: string[];
  /** Persian, math-backed explanation per violation — safe to show the user */
  details: string[];
  adjustedAmount?: number;
}

const fmt = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 2 });

export async function riskCheck(input: RiskCheckInput, adapter: ExchangeAdapter): Promise<RiskDecision> {
  const violations: string[] = [];
  const details: string[] = [];
  const futures = input.market === "FUTURES";
  // futures entries are margin-posted — SELL (short open) is an entry too
  const entry = input.side === "BUY" || (futures && input.side === "SELL");
  const notional = input.amount * input.price;

  // 1. Capital — notional must not exceed allocated capital
  if (notional > input.allocatedCapital) {
    violations.push("CAPITAL_EXCEEDED");
    details.push(`ارزش سفارش ${fmt(notional)} (= ${fmt(input.amount)} × ${fmt(input.price)}) از سرمایه‌ی تخصیص‌یافته ${fmt(input.allocatedCapital)} بیشتر است`);
  }

  // 2. Risk per trade — size bounded by risk %
  const maxRiskNotional = input.allocatedCapital * (input.riskPerTradePct / 100) * 10;
  if (notional > maxRiskNotional && entry) {
    violations.push("RISK_PER_TRADE_EXCEEDED");
    details.push(`حد ریسک هر معامله: ${fmt(input.riskPerTradePct)}٪ × ${fmt(input.allocatedCapital)} × ۱۰ = ${fmt(maxRiskNotional)} ولی نوسینال ${fmt(notional)} است`);
  }

  // 3. Maximum position — pct of allocated capital
  const maxPosition = input.allocatedCapital * (input.maxPositionPct / 100);
  if (notional > maxPosition && entry) {
    violations.push("MAX_POSITION_EXCEEDED");
    details.push(`حداکثر اندازه‌ی پوزیشن ${fmt(input.maxPositionPct)}٪ سرمایه = ${fmt(maxPosition)} ولی نوسینال ${fmt(notional)} است`);
  }

  // 5-6. Pair min/max — looked up first so base-currency checks use the real base
  const basePair = await prisma.pair.findUnique({
    where: { exchange_symbol: { exchange: (input.exchange ?? "NOBITEX").toUpperCase(), symbol: input.symbol } },
  });

  // 4. Available balance on the exchange
  try {
    const balances = await adapter.getBalance();
    if (entry) {
      // margin shorts borrow the base — only the quote margin must exist
      const quote = balances.find((b) => b.currency === "IRT" || b.currency === "USDT");
      if (quote && quote.free < notional) {
        violations.push("INSUFFICIENT_EXCHANGE_BALANCE");
        details.push(`موجودی آزاد ${quote.currency} صرافی ${fmt(quote.free)} کمتر از نیاز سفارش ${fmt(notional)} است`);
      }
    } else {
      const base = (basePair?.baseCurrency ?? input.symbol).replace(/IRT|USDT$|-.*$/, "");
      const b = balances.find((x) => x.currency === base);
      if (b && b.free < input.amount) {
        violations.push("INSUFFICIENT_EXCHANGE_BALANCE");
        details.push(`موجودی آزاد ${base} صرافی ${fmt(b.free)} کمتر از مقدار سفارش ${fmt(input.amount)} است`);
      }
    }
  } catch {
    violations.push("BALANCE_CHECK_FAILED");
    details.push("موجودی صرافی خوانده نشد — چک موجودی ناموفق بود");
  }

  const pair = basePair;
  if (pair) {
    if (pair.minAmount && input.amount < pair.minAmount) {
      violations.push("BELOW_PAIR_MIN");
      details.push(`مقدار ${fmt(input.amount)} کمتر از حداقل مجاز بازار (${fmt(pair.minAmount)}) است`);
    }
    if (pair.maxAmount && input.amount > pair.maxAmount) {
      violations.push("ABOVE_PAIR_MAX");
      details.push(`مقدار ${fmt(input.amount)} بیشتر از حداکثر مجاز بازار (${fmt(pair.maxAmount)}) است`);
    }
    if (!pair.active) {
      violations.push("PAIR_INACTIVE");
      details.push("این جفت‌ارز در صرافی غیرفعال شده است");
    }
  }

  // 7-8. SL/TP sanity — configured on the version, checked by caller

  // 9. Existing open position for this strategy+symbol
  const openTrade = await prisma.trade.findFirst({
    where: { liveStrategyId: input.liveStrategyId, symbol: input.symbol, status: "OPEN" },
  });
  if (openTrade && entry) {
    violations.push("EXISTING_POSITION");
    details.push("روی همین نماد یک پوزیشن باز برای این استراتژی وجود دارد");
  }

  // 10. Existing open order for this strategy+symbol
  const openOrder = await prisma.order.findFirst({
    where: {
      liveStrategyId: input.liveStrategyId,
      symbol: input.symbol,
      status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
    },
  });
  if (openOrder) {
    violations.push("EXISTING_ORDER");
    details.push("یک سفارش باز روی همین نماد هنوز در جریان است");
  }

  // 11. Daily limits — max 50 trades/day per strategy (system setting could override)
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.trade.count({
    where: { liveStrategyId: input.liveStrategyId, openedAt: { gte: dayStart } },
  });
  if (todayTrades >= 50) {
    violations.push("DAILY_LIMIT_REACHED");
    details.push(`امروز ${todayTrades} معامله ثبت شده — سقف روزانه ۵۰ معامله`);
  }

  return { approved: violations.length === 0, violations, details };
}

/** Throwing variant for order paths. */
export async function enforceRisk(input: RiskCheckInput, adapter: ExchangeAdapter): Promise<void> {
  const decision = await riskCheck(input, adapter);
  if (!decision.approved) {
    throw new AppError("RISK_VIOLATION", 422, { violations: decision.violations }, decision.details.join("؛ "));
  }
}
