import { describe, it, expect, vi, afterAll } from "vitest";
import { prisma } from "@/infrastructure/database/prisma";
import { riskCheck, enforceRisk } from "@/modules/trading/risk-engine";
import { checkPortfolioRisk, DEFAULT_PORTFOLIO_RISK } from "@/modules/opportunity/service";
import { AppError } from "@/shared/errors";
import { api } from "@/infrastructure/http/api";
import type { ExchangeAdapter } from "@/modules/exchanges/types";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/infrastructure/logging/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogSink: vi.fn(),
}));

const RUN = `rx-${Date.now()}`;
let userId = "";

const adapter = (balances: { currency: string; free: number }[] = [{ currency: "USDT", free: 1_000_000 }]) =>
  ({ getBalance: async () => balances.map((b) => ({ ...b, total: b.free, locked: 0 })) }) as unknown as ExchangeAdapter;

const baseInput = {
  userId: "u-x", liveStrategyId: "ls-x", symbol: "BTC-USDT", side: "BUY" as const,
  amount: 1, price: 100, allocatedCapital: 10_000,
  riskPerTradePct: 2, maxPositionPct: 100, exchange: "KUCOIN",
};

afterAll(async () => {
  await prisma.pair.deleteMany({ where: { symbol: "TESTX-USDT" } });
  if (userId) {
    await prisma.trade.deleteMany({ where: { userId } });
    await prisma.liveStrategy.deleteMany({ where: { userId } });
    await prisma.strategy.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  }
});

describe("riskCheck — math-backed Persian details", () => {
  it("CAPITAL_EXCEEDED shows notional = amount × price vs allocated capital", async () => {
    const r = await riskCheck({ ...baseInput, amount: 200, price: 100, allocatedCapital: 1_000 }, adapter());
    expect(r.violations).toContain("CAPITAL_EXCEEDED");
    const d = r.details.find((x) => x.includes("ارزش سفارش"))!;
    expect(d).toContain("20,000"); // 200 × 100
    expect(d).toContain("1,000");  // allocated
  });

  it("RISK_PER_TRADE_EXCEEDED shows risk% × capital × 10 vs notional", async () => {
    // 2% × 10,000 × 10 = 2,000 max; notional 3,000 < capital → only this violation fires
    const r = await riskCheck({ ...baseInput, amount: 30, price: 100, riskPerTradePct: 2 }, adapter());
    expect(r.violations).toEqual(["RISK_PER_TRADE_EXCEEDED"]);
    const d = r.details[0];
    expect(d).toContain("2٪");
    expect(d).toContain("2,000"); // max risk notional
    expect(d).toContain("3,000"); // notional
  });

  it("MAX_POSITION_EXCEEDED shows pct of capital vs notional", async () => {
    // 30% of 10,000 = 3,000 max position; notional 5,000 under risk ceiling (2%×10k×10=2,000? no → also risk)
    const r = await riskCheck(
      { ...baseInput, amount: 50, price: 100, riskPerTradePct: 100, maxPositionPct: 30 },
      adapter(),
    );
    expect(r.violations).toEqual(["MAX_POSITION_EXCEEDED"]);
    expect(r.details[0]).toContain("3,000");
    expect(r.details[0]).toContain("5,000");
  });

  it("INSUFFICIENT_EXCHANGE_BALANCE shows free vs required", async () => {
    const r = await riskCheck(
      { ...baseInput, amount: 5, price: 100, riskPerTradePct: 100 },
      adapter([{ currency: "USDT", free: 100 }]),
    );
    expect(r.violations).toContain("INSUFFICIENT_EXCHANGE_BALANCE");
    const d = r.details.find((x) => x.includes("موجودی آزاد"))!;
    expect(d).toContain("100"); // free
    expect(d).toContain("500"); // required
  });

  it("BELOW_PAIR_MIN / ABOVE_PAIR_MAX quote the exchange limits", async () => {
    await prisma.pair.create({
      data: {
        exchange: "KUCOIN", symbol: "TESTX-USDT", baseCurrency: "TESTX", quoteCurrency: "USDT",
        minAmount: 10, maxAmount: 50, active: true,
      },
    });
    const low = await riskCheck(
      { ...baseInput, symbol: "TESTX-USDT", amount: 5, price: 1, allocatedCapital: 10_000, riskPerTradePct: 100 },
      adapter(),
    );
    expect(low.violations).toContain("BELOW_PAIR_MIN");
    expect(low.details.find((d) => d.includes("حداقل مجاز"))).toContain("10");

    const high = await riskCheck(
      { ...baseInput, symbol: "TESTX-USDT", amount: 60, price: 1, allocatedCapital: 10_000, riskPerTradePct: 100, maxPositionPct: 100 },
      adapter([{ currency: "USDT", free: 1_000_000 }]),
    );
    expect(high.violations).toContain("ABOVE_PAIR_MAX");
    expect(high.details.find((d) => d.includes("حداکثر مجاز"))).toContain("50");
  });

  it("enforceRisk throws AppError with detail + violations in context", async () => {
    await expect(
      enforceRisk({ ...baseInput, amount: 200, price: 100, allocatedCapital: 1_000 }, adapter()),
    ).rejects.toMatchObject({ code: "RISK_VIOLATION" });
    try {
      await enforceRisk({ ...baseInput, amount: 200, price: 100, allocatedCapital: 1_000 }, adapter());
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.detail).toContain("ارزش سفارش");
      expect(err.context?.violations).toContain("CAPITAL_EXCEEDED");
    }
  });
});

describe("checkPortfolioRisk — details", () => {
  it("emergency stop explains itself", async () => {
    const r = await checkPortfolioRisk("u-emg-" + RUN, { symbol: "BTC-USDT", exchange: "KUCOIN" },
      { ...DEFAULT_PORTFOLIO_RISK, emergencyStop: true });
    expect(r.violations).toContain("EMERGENCY_STOP");
    expect(r.details[0]).toContain("توقف اضطراری");
  });

  it("MAX_OPEN_POSITIONS reports count vs cap; COOLDOWN reports remaining minutes", async () => {
    const user = await prisma.user.create({ data: { username: RUN, passwordHash: "x", referralCode: RUN } });
    userId = user.id;
    const strategy = await prisma.strategy.create({
      data: {
        userId, name: RUN, status: "LIVE",
        versions: { create: { versionNumber: 1, kind: "SIGNAL", symbol: "BTC-USDT", timeframe: "1h",
          buyThreshold: 0.3, sellThreshold: -0.3, riskPerTradePct: 1, stopLossPct: 1,
          takeProfitPct: 2, maxPositionPct: 100, orderType: "MARKET", config: "{}" } },
      },
      include: { versions: true },
    });
    for (let i = 0; i < 5; i++) {
      await prisma.liveStrategy.create({
        data: { userId, strategyId: strategy.id, versionId: strategy.versions[0].id,
          symbol: `S${i}-USDT`, allocatedCapital: 100, status: "RUNNING", mode: "REAL" },
      });
    }
    // cooldown — a just-closed trade on the same symbol
    const live = await prisma.liveStrategy.findFirst({ where: { userId } });
    await prisma.trade.create({
      data: { userId, liveStrategyId: live!.id, symbol: "BTC-USDT", entryPrice: 1, amount: 1,
        invested: 1, status: "CLOSED", closedAt: new Date(), pnlPct: 1 },
    });

    const r = await checkPortfolioRisk(userId, { symbol: "BTC-USDT", exchange: "KUCOIN" });
    expect(r.violations).toContain("MAX_OPEN_POSITIONS");
    expect(r.violations).toContain("COOLDOWN");
    const pos = r.details.find((d) => d.includes("استراتژی فعال"))!;
    expect(pos).toContain("5");
    const cd = r.details.find((d) => d.includes("کول‌داون"))!;
    expect(cd).toContain("دقیقه");
  });
});

describe("api() — serializes AppError detail", () => {
  it("returns detail alongside error/code/requestId", async () => {
    const handler = api(async () => {
      throw new AppError("RISK_VIOLATION", 422, { violations: ["X"] }, "نوسینال ۵۰۰ از سقف ۱۰۰ بیشتر است");
    }, { public: true });
    const res = await handler(
      { method: "POST", url: "http://localhost/api/test" } as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("RISK_VIOLATION");
    expect(json.detail).toBe("نوسینال ۵۰۰ از سقف ۱۰۰ بیشتر است");
    expect(json.error).toBeTruthy();
    expect(json.requestId).toBeTruthy();
  });

  it("omits detail for plain errors", async () => {
    const handler = api(async () => { throw new AppError("NOT_FOUND", 404); }, { public: true });
    const res = await handler(
      { method: "GET", url: "http://localhost/api/test" } as never,
      { params: Promise.resolve({}) },
    );
    const json = await res.json();
    expect(json.detail).toBeUndefined();
  });
});
