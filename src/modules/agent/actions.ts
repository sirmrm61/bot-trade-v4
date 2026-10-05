import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { getCandles } from "@/modules/pairs/service";
import { publicAdapter } from "@/modules/exchanges/registry";
import { rsi, ema, atr } from "@/modules/indicators/engine";
import { marketStats } from "@/modules/strategies/suggest";
import { createStrategy, updateStrategy, latestVersion, type StrategyInput } from "@/modules/strategies/service";
import { startLiveStrategy, pauseLiveStrategy } from "@/modules/trading/live-engine";
import { futuresPnl } from "@/modules/trading/futures";
import { agentLog } from "./service";
import type { TradingAgent } from "@/generated/prisma/client";

/**
 * Agent actions — the server-side capabilities exposed to the Devin CLI
 * through POST /api/agent (Bearer AGENT_TOKEN). Every action is scoped to
 * the agent's own userId/symbol so one agent can never touch another
 * user's data or another symbol's positions.
 */

type Agent = TradingAgent;
type Params = Record<string, unknown>;

export async function agentAction(agent: Agent, action: string, p: Params): Promise<unknown> {
  switch (action) {
    case "market_summary": return marketSummary(agent);
    case "list_strategies": return listStrategies(agent);
    case "create_strategy": return createAgentStrategy(agent, p);
    case "update_strategy": return updateAgentStrategy(agent, p);
    case "pause_live": return setLiveStatus(agent, true);
    case "resume_live": return resumeLive(agent);
    case "list_trades": return listTrades(agent);
    case "open_trade": return openTrade(agent, p);
    case "close_trade": return closeTrade(agent, p);
    case "log": return writeLog(agent, p);
    default:
      throw new AppError("VALIDATION", 400, { reason: `unknown action: ${action}` });
  }
}

// ---------------------------------------------------------------------------

async function marketSummary(agent: Agent) {
  const adapter = publicAdapter(agent.exchange);
  const ticker = await adapter.getTicker(agent.symbol);
  const candles = await getCandles({
    symbol: agent.symbol, timeframe: "15m",
    start: new Date(Date.now() - 200 * 15 * 60_000), end: new Date(), exchange: agent.exchange,
  }).catch(() => []);
  const closes = candles.map((c) => c.close);
  const stats = candles.length >= 30 ? marketStats(candles) : null;
  const live = agent.liveStrategyId
    ? await prisma.liveStrategy.findUnique({
        where: { id: agent.liveStrategyId },
        select: { status: true, stats: true },
      })
    : null;
  return {
    symbol: agent.symbol, exchange: agent.exchange, mode: agent.mode,
    price: ticker.last, bid: ticker.bid, ask: ticker.ask,
    candles: candles.length,
    rsi14: closes.length > 15 ? round2(rsi(closes, 14).at(-1)) : null,
    ema20: closes.length > 20 ? round2(ema(closes, 20).at(-1)) : null,
    ema50: closes.length > 50 ? round2(ema(closes, 50).at(-1)) : null,
    atr14: candles.length > 15 ? round2(atr(candles, 14).at(-1)) : null,
    lastClose: closes.at(-1) ?? null,
    regime: stats?.regime ?? null,
    volPct: stats ? round2(stats.volPct) : null,
    trendPct: stats ? round2(stats.trendPct) : null,
    atrPct: stats ? round2(stats.atrPct) : null,
    managedStrategy: agent.strategyId,
    liveStatus: live?.status ?? null,
  };
}

async function listStrategies(agent: Agent) {
  const strategies = await prisma.strategy.findMany({
    where: { userId: agent.userId, status: { not: "DELETED" } },
    orderBy: { updatedAt: "desc" },
    take: 30,
    include: {
      versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { kind: true, symbol: true, versionNumber: true } },
      liveStrategies: { where: { status: { in: ["RUNNING", "STARTING", "PAUSED", "DEGRADED"] } }, select: { id: true, status: true, mode: true, symbol: true } },
    },
  });
  return strategies.map((s) => ({
    id: s.id, name: s.name, status: s.status, origin: s.origin,
    kind: s.versions[0]?.kind ?? null, symbol: s.versions[0]?.symbol ?? null,
    version: s.versions[0]?.versionNumber ?? null,
    live: s.liveStrategies[0] ?? null,
    managed: s.id === agent.strategyId,
  }));
}

async function createAgentStrategy(agent: Agent, p: Params) {
  const input = p.input as StrategyInput | undefined;
  if (!input) throw new AppError("VALIDATION", 400, { field: "input" });
  input.symbol = agent.symbol; // the agent only manages its own pair
  const { strategy } = await createStrategy(agent.userId, {
    ...input, name: input.name?.trim() || `ایجنت — ${agent.symbol}`,
  }, "AI");
  const capital = Number(p.allocatedCapital) || 500;
  const live = await startLiveStrategy({
    userId: agent.userId, strategyId: strategy.id,
    allocatedCapital: capital, mode: agent.mode === "REAL" ? "REAL" : "PAPER",
  });
  await prisma.tradingAgent.update({
    where: { id: agent.id },
    data: { strategyId: strategy.id, liveStrategyId: live.id },
  });
  await agentLog(agent.id, "ACTION", `استراتژی «${strategy.name}» ساخته و در حالت ${agent.mode} با سرمایه‌ی ${capital} فعال شد.`);
  return { strategyId: strategy.id, liveStrategyId: live.id, name: strategy.name };
}

async function updateAgentStrategy(agent: Agent, p: Params) {
  if (!agent.strategyId) throw new AppError("VALIDATION", 400, { reason: "no managed strategy" });
  const patch = (p.patch ?? {}) as Partial<StrategyInput>;
  const version = await latestVersion(agent.strategyId);
  if (!version) throw new AppError("NOT_FOUND", 404);
  const merged = { ...JSON.parse(version.config), ...patch } as StrategyInput;
  merged.symbol = agent.symbol;
  const newVersion = await updateStrategy(agent.userId, agent.strategyId, merged);
  await agentLog(agent.id, "ACTION", `پارامترهای استراتژی به نسخه‌ی ${newVersion.versionNumber ?? "?"} اصلاح شد.`);
  return { versionNumber: newVersion.versionNumber };
}

async function setLiveStatus(agent: Agent, pause: boolean) {
  if (!agent.liveStrategyId) throw new AppError("NOT_FOUND", 404, { reason: "no live strategy" });
  if (pause) {
    await pauseLiveStrategy(agent.userId, agent.liveStrategyId);
    await agentLog(agent.id, "ACTION", "استراتژی زنده توسط ایجنت PAUSED شد — ورود جدید متوقف، پوزیشن‌های باز همچنان مدیریت می‌شوند.");
    return { status: "PAUSED" };
  }
  throw new AppError("VALIDATION", 400, { reason: "use resume_live" });
}

async function resumeLive(agent: Agent) {
  if (!agent.liveStrategyId) throw new AppError("NOT_FOUND", 404, { reason: "no live strategy" });
  const live = await prisma.liveStrategy.update({
    where: { id: agent.liveStrategyId, userId: agent.userId },
    data: { status: "RUNNING" },
  });
  await agentLog(agent.id, "ACTION", "استراتژی زنده توسط ایجنت از سر گرفته شد (RUNNING).");
  return { status: live.status };
}

async function listTrades(agent: Agent) {
  if (!agent.liveStrategyId) return { open: [], closed: [] };
  const [open, closed] = await Promise.all([
    prisma.trade.findMany({ where: { liveStrategyId: agent.liveStrategyId, status: "OPEN" } }),
    prisma.trade.findMany({
      where: { liveStrategyId: agent.liveStrategyId, status: "CLOSED" },
      orderBy: { closedAt: "desc" }, take: 10,
    }),
  ]);
  const adapter = publicAdapter(agent.exchange);
  const price = await adapter.getTicker(agent.symbol).then((t) => t.last).catch(() => null);
  return {
    price,
    open: open.map((t) => ({
      id: t.id, side: t.side, entryPrice: t.entryPrice, amount: t.amount, invested: t.invested,
      leverage: t.leverage, stopLossPrice: t.stopLossPrice, takeProfitPrice: t.takeProfitPrice,
      openedAt: t.openedAt,
      pnlPct: price ? round2(futuresPnl(t.entryPrice, price, t.amount, t.side === "SHORT" ? "SHORT" : "LONG") / t.invested * 100) : null,
    })),
    closed: closed.map((t) => ({
      id: t.id, side: t.side, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      pnl: round2(t.pnl), pnlPct: round2(t.pnlPct), exitReason: t.exitReason, closedAt: t.closedAt,
    })),
  };
}

async function openTrade(agent: Agent, p: Params) {
  if (!agent.liveStrategyId) throw new AppError("VALIDATION", 400, { reason: "create_strategy first" });
  const side = String(p.side ?? "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") throw new AppError("VALIDATION", 400, { field: "side" });

  const live = await prisma.liveStrategy.findUnique({
    where: { id: agent.liveStrategyId }, include: { version: true },
  });
  if (!live) throw new AppError("NOT_FOUND", 404);
  const dup = await prisma.trade.findFirst({ where: { liveStrategyId: live.id, status: "OPEN" } });
  if (dup) throw new AppError("VALIDATION", 400, { reason: "position already open", detail: `trade ${dup.id}` });

  const adapter = publicAdapter(agent.exchange);
  const price = (await adapter.getTicker(agent.symbol)).last;
  if (!Number.isFinite(price) || price <= 0) throw new AppError("EXCHANGE_CONNECTION_FAILED", 502);

  const long = side === "LONG";
  const slPrice = long ? price * (1 - live.version.stopLossPct / 100) : price * (1 + live.version.stopLossPct / 100);
  const tpPrice = long ? price * (1 + live.version.takeProfitPct / 100) : price * (1 - live.version.takeProfitPct / 100);
  const invested = live.allocatedCapital * (live.version.maxPositionPct ?? 100) / 100;
  const amount = invested / price;

  const trade = await prisma.trade.create({
    data: {
      userId: agent.userId, liveStrategyId: live.id, symbol: agent.symbol,
      side, leverage: 1, entryPrice: price, amount, invested,
      stopLossPrice: slPrice, takeProfitPrice: tpPrice, trailingPeak: price,
    },
  });
  await agentLog(agent.id, "ACTION",
    `پوزیشن ${long ? "لانگ" : "شورت"} روی ${agent.symbol} باز شد — ورود ${price}، SL ${round2(slPrice)}، TP ${round2(tpPrice)}، سرمایه ${round2(invested)}.`);
  return { tradeId: trade.id, entryPrice: price, amount, invested, stopLossPrice: slPrice, takeProfitPrice: tpPrice };
}

async function closeTrade(agent: Agent, p: Params) {
  const tradeId = String(p.tradeId ?? "");
  const trade = await prisma.trade.findFirst({
    where: { id: tradeId, liveStrategyId: agent.liveStrategyId ?? "", status: "OPEN" },
  });
  if (!trade) throw new AppError("NOT_FOUND", 404, { reason: "open trade not found" });

  const adapter = publicAdapter(agent.exchange);
  const price = (await adapter.getTicker(agent.symbol)).last;
  const long = trade.side !== "SHORT";
  const pnl = futuresPnl(trade.entryPrice, price, trade.amount, long ? "LONG" : "SHORT");
  const pnlPct = trade.invested > 0 ? (pnl / trade.invested) * 100 : 0;
  await prisma.trade.update({
    where: { id: trade.id },
    data: { status: "CLOSED", exitPrice: price, exitReason: "MANUAL", pnl, pnlPct, closedAt: new Date() },
  });
  await agentLog(agent.id, "ACTION",
    `پوزیشن ${long ? "لانگ" : "شورت"} ${agent.symbol} توسط ایجنت بسته شد — خروج ${price}، نتیجه ${round2(pnlPct)}٪${typeof p.reason === "string" ? ` — دلیل: ${p.reason}` : ""}.`);
  return { tradeId: trade.id, exitPrice: price, pnl: round2(pnl), pnlPct: round2(pnlPct) };
}

async function writeLog(agent: Agent, p: Params) {
  const level = ["INFO", "ACTION", "DECISION", "ERROR"].includes(String(p.level)) ? String(p.level) : "INFO";
  const message = String(p.message ?? "").slice(0, 2000);
  if (!message) throw new AppError("VALIDATION", 400, { field: "message" });
  await agentLog(agent.id, level, message);
  return { ok: true };
}

const round2 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
