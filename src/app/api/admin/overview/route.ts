import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";

/** Admin read-all: strategies, backtests, live, trades, referrals, notifications. */
export const GET = api(async (req) => {
  const section = new URL(req.url).searchParams.get("section") ?? "strategies";
  switch (section) {
    case "strategies":
      return { items: await prisma.strategy.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { user: { select: { username: true } }, versions: { take: 1, orderBy: { versionNumber: "desc" } } } }) };
    case "backtests":
      return { items: await prisma.backtest.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { user: { select: { username: true } }, strategy: { select: { name: true } } } }) };
    case "live":
      return { items: await prisma.liveStrategy.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { user: { select: { username: true } }, strategy: { select: { name: true } } } }) };
    case "trades":
      return { items: await prisma.trade.findMany({ orderBy: { openedAt: "desc" }, take: 200, include: { user: { select: { username: true } } } }) };
    case "referrals":
      return { items: await prisma.referral.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { referrer: { select: { username: true } }, referee: { select: { username: true } } } }) };
    default:
      return { items: [] };
  }
}, { admin: true });
