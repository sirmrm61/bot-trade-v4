import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { getCandles } from "@/modules/pairs/service";
import { publicAdapter } from "@/modules/exchanges/registry";
import { rsi, ema, atr } from "@/modules/indicators/engine";
import { marketStats } from "@/modules/strategies/suggest";
import { rankPairs } from "@/modules/scalping/service";
import { createStrategy, updateStrategy, latestVersion, type StrategyInput } from "@/modules/strategies/service";
import { startLiveStrategy, pauseLiveStrategy } from "@/modules/trading/live-engine";
import { futuresPnl } from "@/modules/trading/futures";
import { executeBacktest } from "@/modules/backtest/service";
import { getSetting } from "@/modules/settings/service";
import { agentLog } from "./service";
import { journalWrite, journalRecent } from "./journal";
import { checkEntryGuardrails } from "@/modules/trading/guardrails";
import type { TradingAgent } from "@/generated/prisma/client";

/**
 * Agent actions — the server-side capabilities exposed to the Devin CLI
 * through POST /api/agent (Bearer AGENT_TOKEN). Every action is scoped to
 * the agent's own userId + exchange + managed pair set, so one agent can
 * never touch another user's data or an unmanaged symbol's positions.
 *
 * An agent manages up to `maxPairs` symbols, tracked in the `managed` JSON
 * column: [{ symbol, strategyId, liveStrategyId }]. Legacy single-symbol
 * agents (symbol != "AUTO") synthesize their managed list from the
 * strategyId/liveStrategyId columns.
 */

type Agent = TradingAgent;
type Params = Record<string, unknown>;

export async function agentAction(agent: Agent, action: string, p: Params): Promise<unknown> {
  switch (action) {
    case "scan_pairs": return scanPairs(agent);
    case "set_pairs": return setPairs(agent, p);
    case "market_summary": return marketSummary(agent, p);
    case "list_strategies": return listStrategies(agent);
    case "select_strategy": return selectStrategy(agent, p);
    case "create_strategy": return createAgentStrategy(agent, p);
    case "update_strategy": return updateAgentStrategy(agent, p);
    case "backtest": return runBacktestForAgent(agent, p);
    case "performance": return performance(agent);
    case "pause_live": return setLiveStatus(agent, p, true);
    case "resume_live": return resumeLive(agent, p);
    case "list_trades": return listTrades(agent, p);
    case "open_trade": return openTrade(agent, p);
    case "close_trade": return closeTrade(agent, p);
    case "journal": return getJournal(agent, p);
    case "daily_plan": return dailyPlanView(agent);
    case "forecast": return forecastView(agent, p);
    case "log": return writeLog(agent, p);
    default:
      throw new AppError("VALIDATION", 400, { reason: `unknown action: ${action}` });
  }
}

// ---------------------------------------------------------------------------
// managed-pair helpers
// ---------------------------------------------------------------------------

interface ManagedPair { symbol: string; strategyId: string | null; liveStrategyId: string | null }

function managedList(agent: Agent): ManagedPair[] {
  let arr: ManagedPair[] = [];
  try { arr = JSON.parse(agent.managed ?? "[]"); } catch { arr = []; }
  // legacy single-symbol agents carry their pair in the dedicated columns
  if (!arr.length && agent.symbol !== "AUTO" && (agent.strategyId || agent.liveStrategyId)) {
    arr = [{ symbol: agent.symbol, strategyId: agent.strategyId, liveStrategyId: agent.liveStrategyId }];
  }
  return arr.filter((m) => m?.symbol);
}

async function saveManaged(agent: Agent, list: ManagedPair[]) {
  await prisma.tradingAgent.update({
    where: { id: agent.id },
    data: {
      managed: JSON.stringify(list),
      // keep the legacy columns pointing at the first pair for back-compat
      strategyId: list[0]?.strategyId ?? null,
      liveStrategyId: list[0]?.liveStrategyId ?? null,
    },
  });
}

const managedFor = (agent: Agent, symbol: string) =>
  managedList(agent).find((m) => m.symbol === symbol.toUpperCase());

function requirePair(agent: Agent, p: Params): ManagedPair {
  const symbol = String(p.symbol ?? "").toUpperCase();
  const entry = symbol ? managedFor(agent, symbol) : managedList(agent)[0];
  if (!entry) {
    throw new AppError("VALIDATION", 400, {
      reason: "no managed pairs",
      detail: "call scan_pairs then set_pairs first",
    });
  }
  return entry;
}

// ---------------------------------------------------------------------------
// pair selection
// ---------------------------------------------------------------------------

async function scanPairs(agent: Agent) {
  const result = await rankPairs({ exchange: agent.exchange, quote: "USDT" });
  const managed = new Set(managedList(agent).map((m) => m.symbol));
  return {
    maxPairs: agent.maxPairs,
    managed: [...managed],
    candidates: result.pairs.slice(0, 15).map((r) => ({
      symbol: r.symbol,
      marketType: r.marketType,
      score: r.score,
      volumeUsd24h: round2(r.metrics.volumeUsd24h),
      spreadPct: round2(r.metrics.spreadPct),
      volatilityPct: round2(r.metrics.volatilityPct),
      dayRangePct: round2(r.metrics.dayRangePct),
      alreadyManaged: managed.has(r.symbol),
      reasons: r.reasons.slice(0, 2),
    })),
  };
}

async function setPairs(agent: Agent, p: Params) {
  const symbols = Array.isArray(p.symbols) ? p.symbols.map((s) => String(s).toUpperCase()) : [];
  if (!symbols.length) throw new AppError("VALIDATION", 400, { field: "symbols" });
  if (symbols.length > agent.maxPairs) {
    throw new AppError("VALIDATION", 400, { reason: `max ${agent.maxPairs} pairs allowed` });
  }
  const found = await prisma.pair.findMany({
    where: { symbol: { in: symbols }, exchange: agent.exchange, active: true, quoteCurrency: "USDT" },
    select: { symbol: true },
  });
  const valid = new Set(found.map((f) => f.symbol));
  const missing = symbols.filter((s) => !valid.has(s));
  if (missing.length) {
    throw new AppError("VALIDATION", 400, { reason: `unknown/inactive USDT pairs on ${agent.exchange} — base currency is USDT`, detail: missing.join(",") });
  }

  const prev = managedList(agent);
  const next: ManagedPair[] = symbols.map((s) =>
    prev.find((m) => m.symbol === s) ?? { symbol: s, strategyId: null, liveStrategyId: null });
  await saveManaged(agent, next);

  // dropped pairs: pause their live so they can't keep trading unmanaged
  const dropped = prev.filter((m) => !symbols.includes(m.symbol) && m.liveStrategyId);
  for (const d of dropped) {
    await pauseLiveStrategy(agent.userId, d.liveStrategyId!).catch(() => {});
  }

  await agentLog(agent.id, "ACTION",
    `جفت‌ارزهای تحت مدیریت تعیین شد: ${symbols.join("، ")}${dropped.length ? ` — جفت‌های حذف‌شده متوقف شدند: ${dropped.map((d) => d.symbol).join("، ")}` : ""}`);
  await journalWrite(agent.id, "DECISION", `جفت‌ارزها تنظیم شد: ${symbols.join("، ")}`,
    { reason: typeof p.reason === "string" ? p.reason : undefined, data: { dropped: dropped.map((d) => d.symbol) } });
  return { managed: next };
}

// ---------------------------------------------------------------------------
// market data
// ---------------------------------------------------------------------------

async function marketSummary(agent: Agent, p: Params) {
  const symbol = String(p.symbol ?? "").toUpperCase() || managedList(agent)[0]?.symbol;
  if (!symbol) {
    throw new AppError("VALIDATION", 400, { reason: "no symbol", detail: "pass {symbol} or run set_pairs first" });
  }
  const adapter = publicAdapter(agent.exchange);
  const ticker = await adapter.getTicker(symbol);
  const candles = await getCandles({
    symbol, timeframe: "15m",
    start: new Date(Date.now() - 200 * 15 * 60_000), end: new Date(), exchange: agent.exchange,
  }).catch(() => []);
  const closes = candles.map((c) => c.close);
  const stats = candles.length >= 30 ? marketStats(candles) : null;
  const entry = managedFor(agent, symbol);
  const live = entry?.liveStrategyId
    ? await prisma.liveStrategy.findUnique({
        where: { id: entry.liveStrategyId },
        select: { status: true },
      })
    : null;
  return {
    symbol, exchange: agent.exchange, mode: agent.mode,
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
    managedStrategy: entry?.strategyId ?? null,
    liveStatus: live?.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------

async function listStrategies(agent: Agent) {
  const managed = managedList(agent);
  const managedByStrategy = new Map<string, string[]>();
  for (const m of managed) {
    if (m.strategyId) managedByStrategy.set(m.strategyId, [...(managedByStrategy.get(m.strategyId) ?? []), m.symbol]);
  }
  const strategies = await prisma.strategy.findMany({
    where: { userId: agent.userId, status: { not: "DELETED" } },
    orderBy: { updatedAt: "desc" },
    take: 40,
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
    managedFor: managedByStrategy.get(s.id) ?? [],
  }));
}

/** attach an existing user strategy to a managed pair (or create live for it) */
async function selectStrategy(agent: Agent, p: Params) {
  const entry = requirePair(agent, p);
  const strategyId = String(p.strategyId ?? "");
  const strategy = await prisma.strategy.findFirst({
    where: { id: strategyId, userId: agent.userId, status: { not: "DELETED" } },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404, { field: "strategyId" });
  const version = await latestVersion(strategy.id);
  if (!version) throw new AppError("STRATEGY_NOT_READY", 400);
  if (version.symbol !== entry.symbol) {
    throw new AppError("VALIDATION", 400, {
      reason: `strategy symbol is ${version.symbol}, not ${entry.symbol}`,
      detail: "pick a strategy for this pair or create_strategy instead",
    });
  }

  // pause the previous managed live for this pair — only one runs at a time
  if (entry.liveStrategyId && entry.liveStrategyId !== undefined) {
    await pauseLiveStrategy(agent.userId, entry.liveStrategyId).catch(() => {});
  }

  const capital = Number(p.allocatedCapital) || (await suggestedCapital(agent));
  const live = await startLiveStrategy({
    userId: agent.userId, strategyId: strategy.id,
    allocatedCapital: capital, mode: agent.mode === "REAL" ? "REAL" : "PAPER",
  });

  const list = managedList(agent).map((m) =>
    m.symbol === entry.symbol ? { ...m, strategyId: strategy.id, liveStrategyId: live.id } : m);
  await saveManaged(agent, list);
  await agentLog(agent.id, "ACTION",
    `استراتژی موجود «${strategy.name}» برای ${entry.symbol} در حالت ${agent.mode} با سرمایه‌ی ${capital} فعال شد.`);
  await journalWrite(agent.id, "STRATEGY_CHANGE", `استراتژی «${strategy.name}» برای ${entry.symbol} فعال شد`,
    { reason: typeof p.reason === "string" ? p.reason : undefined, strategyId: strategy.id, versionId: version.id });
  return { strategyId: strategy.id, liveStrategyId: live.id, name: strategy.name };
}

async function createAgentStrategy(agent: Agent, p: Params) {
  const entry = requirePair(agent, p);
  const input = p.input as StrategyInput | undefined;
  if (!input) throw new AppError("VALIDATION", 400, { field: "input" });
  input.symbol = entry.symbol;
  input.exchange = agent.exchange; // ticks must resolve the agent's exchange, not the NOBITEX default
  const { strategy } = await createStrategy(agent.userId, {
    ...input, name: input.name?.trim() || `ایجنت — ${entry.symbol}`,
  }, "AI");

  // the pair keeps exactly one running live — pause the previous one so no
  // orphan strategy keeps trading this symbol after the switch
  if (entry.liveStrategyId) {
    await pauseLiveStrategy(agent.userId, entry.liveStrategyId).catch(() => {});
  }

  const capital = Number(p.allocatedCapital) || (await suggestedCapital(agent));
  const live = await startLiveStrategy({
    userId: agent.userId, strategyId: strategy.id,
    allocatedCapital: capital, mode: agent.mode === "REAL" ? "REAL" : "PAPER",
  });

  const list = managedList(agent).map((m) =>
    m.symbol === entry.symbol ? { ...m, strategyId: strategy.id, liveStrategyId: live.id } : m);
  await saveManaged(agent, list);
  await agentLog(agent.id, "ACTION",
    `استراتژی «${strategy.name}» برای ${entry.symbol} ساخته و در حالت ${agent.mode} با سرمایه‌ی ${capital} فعال شد.`);
  await journalWrite(agent.id, "STRATEGY_CHANGE", `استراتژی «${strategy.name}» برای ${entry.symbol} ساخته شد`,
    { reason: typeof p.reason === "string" ? p.reason : undefined, strategyId: strategy.id });
  return { strategyId: strategy.id, liveStrategyId: live.id, name: strategy.name };
}

async function updateAgentStrategy(agent: Agent, p: Params) {
  const entry = requirePair(agent, p);
  if (!entry.strategyId) throw new AppError("VALIDATION", 400, { reason: "no managed strategy for this pair" });
  const patch = (p.patch ?? {}) as Partial<StrategyInput>;
  const version = await latestVersion(entry.strategyId);
  if (!version) throw new AppError("NOT_FOUND", 404);
  const merged = { ...JSON.parse(version.config), ...patch } as StrategyInput;
  merged.symbol = entry.symbol;
  const newVersion = await updateStrategy(agent.userId, entry.strategyId, merged);
  await agentLog(agent.id, "ACTION",
    `پارامترهای استراتژی ${entry.symbol} به نسخه‌ی ${newVersion.versionNumber ?? "?"} اصلاح شد.`);
  return { versionNumber: newVersion.versionNumber };
}

/** run a backtest for the pair's strategy (or a given one) — inline, ~30d */
async function runBacktestForAgent(agent: Agent, p: Params) {
  const entry = managedList(agent)[0] ? requirePair(agent, p) : null;
  const strategyId = String(p.strategyId ?? "") || entry?.strategyId;
  if (!strategyId) {
    throw new AppError("VALIDATION", 400, { field: "strategyId", detail: "or pass {symbol} with a managed strategy" });
  }
  const strategy = await prisma.strategy.findFirst({
    where: { id: strategyId, userId: agent.userId, status: { not: "DELETED" } },
  });
  if (!strategy) throw new AppError("NOT_FOUND", 404, { field: "strategyId" });
  const version = await latestVersion(strategy.id);
  if (!version) throw new AppError("STRATEGY_NOT_READY", 400);

  const days = Math.min(Math.max(Number(p.days) || 30, 7), 90);
  const backtest = await prisma.backtest.create({
    data: {
      userId: agent.userId, strategyId: strategy.id, versionId: version.id,
      symbol: version.symbol, timeframe: version.timeframe,
      startDate: new Date(Date.now() - days * 86_400_000), endDate: new Date(),
      initialBalance: Number(p.initialBalance) || 1000,
      feePct: await getSetting<number>("BACKTEST_FEE_PCT"),
      slippagePct: await getSetting<number>("BACKTEST_SLIPPAGE_PCT"),
      status: "QUEUED", idempotencyKey: `agent-${agent.id}-${Date.now()}`,
    },
  });
  const result = await executeBacktest(backtest.id);
  if (!result) {
    const failed = await prisma.backtest.findUnique({ where: { id: backtest.id }, select: { error: true } });
    throw new AppError("VALIDATION", 400, { reason: "backtest failed", detail: failed?.error ?? "unknown" });
  }
  await agentLog(agent.id, "ACTION",
    `بک‌تست ${days}روزه‌ی استراتژی «${strategy.name}» روی ${version.symbol}: سود خالص ${round2(result.profitPct)}٪، ${result.totalTrades} معامله، وین‌ریت ${round2(result.winRate)}٪، ماکس‌درو‌داون ${round2(result.maxDrawdown)}٪.`);
  await journalWrite(agent.id, "BACKTEST",
    `بک‌تست ${days}روزه‌ی «${strategy.name}» روی ${version.symbol}: ${round2(result.profitPct)}٪`,
    { strategyId: strategy.id, versionId: version.id,
      data: { profitPct: result.profitPct, winRate: result.winRate, totalTrades: result.totalTrades, maxDrawdown: result.maxDrawdown, profitFactor: result.profitFactor } });
  return {
    backtestId: backtest.id, strategyId: strategy.id, symbol: version.symbol,
    days, profitPct: round2(result.profitPct), winRate: round2(result.winRate),
    totalTrades: result.totalTrades, maxDrawdownPct: round2(result.maxDrawdown),
    profitFactor: round2(result.profitFactor),
  };
}

// ---------------------------------------------------------------------------
// live control + trades
// ---------------------------------------------------------------------------

async function setLiveStatus(agent: Agent, p: Params, pause: boolean) {
  const entry = requirePair(agent, p);
  if (!entry.liveStrategyId) throw new AppError("NOT_FOUND", 404, { reason: `no live strategy for ${entry.symbol}` });
  if (!pause) throw new AppError("VALIDATION", 400, { reason: "use resume_live" });
  await pauseLiveStrategy(agent.userId, entry.liveStrategyId);
  await agentLog(agent.id, "ACTION",
    `استراتژی زنده‌ی ${entry.symbol} توسط ایجنت PAUSED شد — ورود جدید متوقف، پوزیشن‌های باز همچنان مدیریت می‌شوند.`);
  return { status: "PAUSED" };
}

async function resumeLive(agent: Agent, p: Params) {
  const entry = requirePair(agent, p);
  if (!entry.liveStrategyId) throw new AppError("NOT_FOUND", 404, { reason: `no live strategy for ${entry.symbol}` });
  const live = await prisma.liveStrategy.update({
    where: { id: entry.liveStrategyId, userId: agent.userId },
    data: { status: "RUNNING" },
  });
  await agentLog(agent.id, "ACTION", `استراتژی زنده‌ی ${entry.symbol} توسط ایجنت از سر گرفته شد (RUNNING).`);
  return { status: live.status };
}

async function listTrades(agent: Agent, p: Params) {
  const list = managedList(agent);
  const symbol = String(p.symbol ?? "").toUpperCase();
  const entries = symbol ? list.filter((m) => m.symbol === symbol) : list;
  if (!entries.length) {
    throw new AppError("VALIDATION", 400, { reason: "no managed pairs", detail: "call scan_pairs then set_pairs first" });
  }

  const liveIds = entries.map((e) => e.liveStrategyId).filter(Boolean) as string[];
  const [open, closed] = await Promise.all([
    prisma.trade.findMany({ where: { liveStrategyId: { in: liveIds }, status: "OPEN" } }),
    prisma.trade.findMany({
      where: { liveStrategyId: { in: liveIds }, status: "CLOSED" },
      orderBy: { closedAt: "desc" }, take: 15,
    }),
  ]);

  const adapter = publicAdapter(agent.exchange);
  const prices = new Map<string, number>();
  for (const e of entries) {
    const t = await adapter.getTicker(e.symbol).catch(() => null);
    if (t) prices.set(e.symbol, t.last);
  }

  return {
    pairs: entries.map((e) => ({ symbol: e.symbol, liveStatus: undefined, liveStrategyId: e.liveStrategyId })),
    open: open.map((t) => {
      const price = prices.get(t.symbol);
      return {
        id: t.id, symbol: t.symbol, side: t.side, entryPrice: t.entryPrice, amount: t.amount, invested: t.invested,
        leverage: t.leverage, stopLossPrice: t.stopLossPrice, takeProfitPrice: t.takeProfitPrice,
        openedAt: t.openedAt,
        pnlPct: price ? round2(futuresPnl(t.entryPrice, price, t.amount, t.side === "SHORT" ? "SHORT" : "LONG") / t.invested * 100) : null,
      };
    }),
    closed: closed.map((t) => ({
      id: t.id, symbol: t.symbol, side: t.side, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      pnl: round2(t.pnl), pnlPct: round2(t.pnlPct), exitReason: t.exitReason, closedAt: t.closedAt,
    })),
  };
}

/** 24h progress toward the daily profit target across all managed pairs */
async function performance(agent: Agent) {
  const liveIds = managedList(agent).map((m) => m.liveStrategyId).filter(Boolean) as string[];
  if (!liveIds.length) return { message: "no live strategies yet", targetPctPerDay: 5 };
  const since = new Date(Date.now() - 86_400_000);
  const [closed, open, lives] = await Promise.all([
    prisma.trade.findMany({ where: { liveStrategyId: { in: liveIds }, status: "CLOSED", closedAt: { gte: since } } }),
    prisma.trade.findMany({ where: { liveStrategyId: { in: liveIds }, status: "OPEN" } }),
    prisma.liveStrategy.findMany({ where: { id: { in: liveIds } }, select: { allocatedCapital: true } }),
  ]);
  const realized = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const capital = lives.reduce((s, l) => s + l.allocatedCapital, 0);
  const adapter = publicAdapter(agent.exchange);
  let unrealized = 0;
  for (const t of open) {
    const tick = await adapter.getTicker(t.symbol).catch(() => null);
    if (tick) unrealized += futuresPnl(t.entryPrice, tick.last, t.amount, t.side === "SHORT" ? "SHORT" : "LONG");
  }
  const realizedPct = capital > 0 ? (realized / capital) * 100 : 0;
  const unrealizedPct = capital > 0 ? (unrealized / capital) * 100 : 0;
  return {
    targetPctPerDay: 5,
    capitalTotal: round2(capital),
    realizedPnl24h: round2(realized), realizedPct24h: round2(realizedPct),
    unrealizedPnl: round2(unrealized), unrealizedPct: round2(unrealizedPct),
    openTrades: open.length, closedTrades24h: closed.length,
    onTarget: realizedPct + unrealizedPct >= 5,
  };
}

async function openTrade(agent: Agent, p: Params) {
  const entry = requirePair(agent, p);
  if (!entry.liveStrategyId) {
    throw new AppError("VALIDATION", 400, { reason: `no live strategy for ${entry.symbol}`, detail: "create_strategy or select_strategy first" });
  }
  const side = String(p.side ?? "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") throw new AppError("VALIDATION", 400, { field: "side" });

  const live = await prisma.liveStrategy.findUnique({
    where: { id: entry.liveStrategyId }, include: { version: true },
  });
  if (!live) throw new AppError("NOT_FOUND", 404);
  const dup = await prisma.trade.findFirst({ where: { liveStrategyId: live.id, status: "OPEN" } });
  if (dup) throw new AppError("VALIDATION", 400, { reason: "position already open", detail: `trade ${dup.id}` });

  // the same fences the engine enforces — the agent can't route around them
  const guard = await checkEntryGuardrails(live, {
    agentId: agent.id,
    slPct: live.version.stopLossPct,
    tpPct: live.version.takeProfitPct,
  });
  if (!guard.allow) {
    throw new AppError("RISK_VIOLATION", 422, { code: guard.code }, guard.reason);
  }

  // daily plan state machine — only tightens (LOCKED blocks, states halve size)
  const { refreshDailyPlan, dailyEntryGate, tradesTodayForAgent } = await import("@/modules/trading/daily-plan");
  const plan = await refreshDailyPlan(agent);
  const dGate = dailyEntryGate(plan);
  if (!dGate.allow) {
    throw new AppError("RISK_VIOLATION", 422, { code: "DAILY_LOCKED" }, dGate.reason);
  }
  if (await tradesTodayForAgent(agent.id) >= plan.maxTrades) {
    throw new AppError("RISK_VIOLATION", 422, { code: "DAILY_MAXTRADES" }, `سقف ${plan.maxTrades} معامله در روز`);
  }

  // forecast gate — probability + EV; active in PAPER (trial), REAL only via env
  let forecastMult = 1;
  if (agent.mode === "PAPER" || process.env.FORECAST_REAL === "1") {
    const { forecastGate } = await import("@/modules/forecast/service");
    const fg = await forecastGate({
      exchange: agent.exchange, symbol: entry.symbol, side,
      slPct: live.version.stopLossPct, tpPct: live.version.takeProfitPct,
      minProbability: dGate.minForecastP,
    });
    if (fg.applies && !fg.allow) {
      throw new AppError("RISK_VIOLATION", 422, { code: "FORECAST" }, fg.reason);
    }
    if (fg.applies) forecastMult = fg.sizeMult ?? 1;
  }

  const adapter = publicAdapter(agent.exchange);
  const price = (await adapter.getTicker(entry.symbol)).last;
  if (!Number.isFinite(price) || price <= 0) throw new AppError("EXCHANGE_CONNECTION_FAILED", 502);

  const long = side === "LONG";
  const slPrice = long ? price * (1 - live.version.stopLossPct / 100) : price * (1 + live.version.stopLossPct / 100);
  const tpPrice = long ? price * (1 + live.version.takeProfitPct / 100) : price * (1 - live.version.takeProfitPct / 100);
  const invested = live.allocatedCapital * (live.version.maxPositionPct ?? 100) / 100 * (live.sizeScale ?? 1) * dGate.sizeScale * forecastMult;
  const amount = invested / price;

  const trade = await prisma.trade.create({
    data: {
      userId: agent.userId, liveStrategyId: live.id, symbol: entry.symbol,
      side, leverage: 1, entryPrice: price, amount, invested,
      stopLossPrice: slPrice, takeProfitPrice: tpPrice, trailingPeak: price,
    },
  });
  await agentLog(agent.id, "ACTION",
    `پوزیشن ${long ? "لانگ" : "شورت"} روی ${entry.symbol} باز شد — ورود ${price}، SL ${round2(slPrice)}، TP ${round2(tpPrice)}، سرمایه ${round2(invested)}.`);
  await journalWrite(agent.id, "TRADE_OPEN", `پوزیشن ${side} روی ${entry.symbol} در ${price} باز شد`,
    { reason: typeof p.reason === "string" ? p.reason : undefined,
      data: { tradeId: trade.id, price, slPrice, tpPrice, invested } });
  return { tradeId: trade.id, entryPrice: price, amount, invested, stopLossPrice: slPrice, takeProfitPrice: tpPrice };
}

async function closeTrade(agent: Agent, p: Params) {
  const tradeId = String(p.tradeId ?? "");
  const liveIds = managedList(agent).map((m) => m.liveStrategyId).filter(Boolean) as string[];
  const trade = await prisma.trade.findFirst({
    where: { id: tradeId, liveStrategyId: { in: liveIds.length ? liveIds : ["-"] }, status: "OPEN" },
  });
  if (!trade) throw new AppError("NOT_FOUND", 404, { reason: "open trade not found" });

  const adapter = publicAdapter(agent.exchange);
  const price = (await adapter.getTicker(trade.symbol)).last;
  const long = trade.side !== "SHORT";
  const pnl = futuresPnl(trade.entryPrice, price, trade.amount, long ? "LONG" : "SHORT");
  const pnlPct = trade.invested > 0 ? (pnl / trade.invested) * 100 : 0;
  await prisma.trade.update({
    where: { id: trade.id },
    data: { status: "CLOSED", exitPrice: price, exitReason: "MANUAL", pnl, pnlPct, closedAt: new Date() },
  });
  await agentLog(agent.id, "ACTION",
    `پوزیشن ${long ? "لانگ" : "شورت"} ${trade.symbol} توسط ایجنت بسته شد — خروج ${price}، نتیجه ${round2(pnlPct)}٪${typeof p.reason === "string" ? ` — دلیل: ${p.reason}` : ""}.`);
  await journalWrite(agent.id, "TRADE_CLOSE", `پوزیشن ${trade.symbol} بسته شد — ${round2(pnlPct)}٪`,
    { reason: typeof p.reason === "string" ? p.reason : undefined,
      data: { tradeId: trade.id, exitPrice: price, pnl, pnlPct } });
  return { tradeId: trade.id, exitPrice: price, pnl: round2(pnl), pnlPct: round2(pnlPct) };
}

/** today's plan + state machine — the agent reads this each cycle */
async function dailyPlanView(agent: Agent) {
  const { ensureDailyPlan, refreshDailyPlan, dailyEntryGate } = await import("@/modules/trading/daily-plan");
  await ensureDailyPlan(agent);
  const plan = await refreshDailyPlan(agent);
  const gate = dailyEntryGate(plan);
  const note = plan.forecastNote ? JSON.parse(plan.forecastNote) : null;
  return {
    date: plan.date, state: plan.state, stateReason: plan.lockedReason,
    realizedPnlPct: round2(plan.realizedPnlPct), peakPnlPct: round2(plan.peakPnlPct),
    targets: { min: plan.targetMin, normal: plan.targetNormal, stretch: plan.targetStretch },
    tradesToday: plan.tradesToday, maxTrades: plan.maxTrades,
    sizeScale: gate.sizeScale, minForecastP: gate.minForecastP,
    entriesAllowed: gate.allow, gateReason: gate.reason ?? null,
    forecastNote: note,
  };
}

/** current probabilistic forecasts for a managed pair (null = no honest model) */
async function forecastView(agent: Agent, p: Params) {
  const entry = requirePair(agent, p);
  const { predictNow } = await import("@/modules/forecast/service");
  const horizons = [
    { horizon: "5m", timeframe: "5m" }, { horizon: "15m", timeframe: "15m" },
    { horizon: "1h", timeframe: "15m" }, { horizon: "4h", timeframe: "1h" },
    { horizon: "12h", timeframe: "1h" },
  ];
  const out = [];
  for (const h of horizons) {
    const f = await predictNow(agent.exchange, entry.symbol, h.timeframe, h.horizon).catch(() => null);
    out.push({ horizon: h.horizon, ...(f ? { pUp: round2(f.probability * 100), confidence: round2(f.confidence * 100), versionId: f.versionId } : { available: false }) });
  }
  const recent = await prisma.prediction.findMany({
    where: { symbol: entry.symbol, exchange: agent.exchange },
    orderBy: { createdAt: "desc" }, take: 10,
    select: { horizon: true, probability: true, outcome: true, createdAt: true },
  });
  return { symbol: entry.symbol, now: out, recent: recent.map((r) => ({ horizon: r.horizon, pUp: round2(r.probability * 100), outcome: r.outcome, createdAt: r.createdAt })) };
}

/** recent journal entries — the agent's audit-trail memory */
async function getJournal(agent: Agent, p: Params) {
  const take = Math.min(Math.max(Number(p.take) || 50, 1), 100);
  const type = typeof p.type === "string" ? p.type : undefined;
  const entries = await journalRecent(agent.id, take, type as never);
  return {
    entries: entries.map((e) => ({
      type: e.type, summary: e.summary, reason: e.reason,
      strategyId: e.strategyId, createdAt: e.createdAt,
    })),
  };
}

async function writeLog(agent: Agent, p: Params) {
  const level = ["INFO", "ACTION", "DECISION", "ERROR"].includes(String(p.level)) ? String(p.level) : "INFO";
  const message = String(p.message ?? "").slice(0, 2000);
  if (!message) throw new AppError("VALIDATION", 400, { field: "message" });
  await agentLog(agent.id, level, message);
  return { ok: true };
}

/**
 * Default position capital when the agent doesn't specify one.
 * REAL agents: split 80% of the free quote balance across maxPairs —
 * sized from the user's actual exchange balance, never all-in.
 * PAPER agents: fixed 500.
 */
async function suggestedCapital(agent: Agent): Promise<number> {
  if (agent.mode !== "REAL") return 500;
  try {
    const { adapterForUser } = await import("@/modules/exchanges/registry");
    const adapter = await adapterForUser(agent.userId, agent.exchange, "agent");
    const balances = await adapter.getBalance();
    const quote = balances.find((b) => b.currency === "USDT") ?? balances.find((b) => b.currency === "IRT");
    if (!quote || quote.free <= 0) return 500;
    return Math.floor((quote.free * 0.8) / Math.max(agent.maxPairs, 1));
  } catch {
    return 500;
  }
}

const round2 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
