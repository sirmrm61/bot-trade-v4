import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { runBacktest } from "@/modules/backtest/engine";
import { atrStopsFromIndicators } from "@/modules/backtest/service";
import { readMarketConfig, readExchange } from "@/modules/trading/futures";
import { obiBacktestSignal } from "@/modules/trading/orderbook-imbalance";
import { isSymbolicKind, symbolicSignalFn } from "@/modules/trading/symbolic-engines";
import { smartEnabled, smartSignalFn } from "@/modules/trading/smart";
import { parseJson } from "@/shared/utils";
import type { StrategyIndicatorConfig } from "@/modules/signals/engine";
import type { TraceEvent } from "./types";

/**
 * Trace service — reconstructs the full decision chain of any traced run.
 *
 *   traceTrade(tradeTraceId)  → one trade's whole story, stage by stage
 *   traceRun(runId)           → every event of a backtest/scan run
 *   replayTrade(tradeTraceId) → deterministic re-simulation + mismatch report
 */

const toNum = (v: bigint | number | null | undefined) => (v == null ? null : Number(v));

function decodeEvent(e: {
  seq: number; ts: bigint; runId: string; refId: string | null; stage: string;
  event: string; symbol: string | null; barIndex: number | null; candleTs: bigint | null;
  data: string | null;
}): TraceEvent {
  return {
    seq: e.seq, ts: toNum(e.ts) ?? 0, runId: e.runId, refId: e.refId ?? undefined,
    stage: e.stage as TraceEvent["stage"], event: e.event,
    symbol: e.symbol ?? undefined, barIndex: e.barIndex ?? undefined,
    candleTs: toNum(e.candleTs) ?? undefined,
    data: e.data ? parseJson(e.data, undefined) : undefined,
  };
}

/** every recorded event of a run (backtest or scan), ordered by seq */
export async function traceRun(userId: string, runId: string) {
  const events = await prisma.traceEvent.findMany({
    where: { runId, OR: [{ backtest: { userId } }, { backtestId: null }] },
    orderBy: { seq: "asc" },
    take: 100_000,
  });
  return events.map(decodeEvent);
}

/**
 * The headline API: pass a tradeTraceId, get the complete chain —
 * market → scanner → strategy → cost → entry → position → exit → pnl audit.
 */
export async function traceTrade(userId: string, tradeTraceId: string) {
  const trade = await prisma.backtestTrade.findFirst({
    where: { traceId: tradeTraceId, backtest: { userId } },
    include: {
      backtest: {
        select: {
          id: true, strategyId: true, symbol: true, timeframe: true,
          startDate: true, endDate: true, traceLevel: true,
          strategy: { select: { name: true } },
        },
      },
    },
  });
  if (!trade) throw new AppError("NOT_FOUND", 404, { tradeTraceId });

  // the self-contained chain stored on the trade + any run-level events that
  // reference it (rejections/summary always live in TraceEvent)
  const own = trade.trace ? (parseJson<TraceEvent[]>(trade.trace, [])) : [];
  const shared = await prisma.traceEvent.findMany({
    where: { refId: tradeTraceId },
    orderBy: { seq: "asc" },
  });
  const merged = [...own, ...shared.map(decodeEvent)]
    .sort((a, b) => a.seq - b.seq)
    .filter((e, i, arr) => arr.findIndex((x) => x.seq === e.seq && x.event === e.event) === i);

  return {
    backtestRunId: `bt-${trade.backtestId}`,
    backtestId: trade.backtestId,
    tradeTraceId,
    strategy: { id: trade.backtest.strategyId, name: trade.backtest.strategy.name },
    symbol: trade.backtest.symbol,
    timeframe: trade.backtest.timeframe,
    window: { start: trade.backtest.startDate, end: trade.backtest.endDate },
    trade: {
      side: trade.side, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
      amount: trade.amount, fee: trade.fee, pnl: trade.pnl, pnlPct: trade.pnlPct,
      entryTime: trade.entryTime, exitTime: trade.exitTime, exitReason: trade.exitReason,
    },
    traceLevel: trade.backtest.traceLevel,
    events: merged,
  };
}

/**
 * Deterministic replay — re-runs the recorded candle window through the same
 * engine with the same params, then compares the matching trade's
 * entry/exit/pnl. Any drift → REPLAY_MISMATCH with the differing fields.
 */
export async function replayTrade(userId: string, tradeTraceId: string) {
  const trade = await prisma.backtestTrade.findFirst({
    where: { traceId: tradeTraceId, backtest: { userId } },
    include: { backtest: { include: { version: { include: { indicators: true } } } } },
  });
  if (!trade?.backtest.version) throw new AppError("NOT_FOUND", 404, { tradeTraceId });
  const bt = trade.backtest;
  const v = bt.version!;

  // the window must cover the indicator warm-up before the signal bar
  const step = tfMs(bt.timeframe);
  const start = new Date(trade.entryTime.getTime() - 300 * step);
  const end = new Date((trade.exitTime?.getTime() ?? trade.entryTime.getTime()) + 5 * step);
  const candles = await getCandles({
    symbol: bt.symbol, timeframe: bt.timeframe, start, end,
    exchange: readExchange(v.config),
  });
  if (candles.length < 70) {
    return { match: false, reason: "INSUFFICIENT_DATA", candles: candles.length, diffs: ["historical candles no longer available for the window"] };
  }

  const marketCfg = readMarketConfig(v.config);
  const kind = v.kind ?? "SIGNAL";
  const indicators: StrategyIndicatorConfig[] = v.indicators.map((i) => ({
    name: i.name, parameters: parseJson(i.parameters, {}), weight: i.weight,
    enabled: i.enabled, buyCondition: i.buyCondition, sellCondition: i.sellCondition,
  }));

  const result = runBacktest({
    candles, indicators,
    buyThreshold: v.buyThreshold, sellThreshold: v.sellThreshold,
    initialBalance: bt.initialBalance, riskPerTradePct: v.riskPerTradePct,
    stopLossPct: v.stopLossPct, takeProfitPct: v.takeProfitPct,
    trailingStop: v.trailingStop, trailingStopPct: v.trailingStopPct ?? undefined,
    atrStops: atrStopsFromIndicators(v.indicators),
    feePct: bt.feePct, slippagePct: bt.slippagePct,
    executionDelayMs: bt.executionDelayMs, partialFill: bt.partialFill,
    market: marketCfg.market, leverage: marketCfg.leverage,
    signalFn: kind === "ORDER_BOOK_IMBALANCE"
      ? obiBacktestSignal(candles, v.config, v.buyThreshold, v.sellThreshold)
      : isSymbolicKind(kind)
        ? smartEnabled(v.config)
          ? smartSignalFn(kind, candles, v.config)
          : symbolicSignalFn(kind, candles, v.config)
        : undefined,
  });

  // the replayed run may contain several trades — match by entry timestamp,
  // which is deterministic given identical inputs
  const entryMs = trade.entryTime.getTime();
  const replayed = result.trades.find((t) => t.entryTime === entryMs);
  if (!replayed) {
    return {
      match: false, reason: "REPLAY_MISMATCH",
      diffs: [`no replayed trade with entryTime=${new Date(entryMs).toISOString()} — ${result.trades.length} trades replayed`],
    };
  }

  const diffs: string[] = [];
  const cmp = (name: string, a: number | string | null | undefined, b: number | string | null | undefined) => {
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > Math.max(1e-6, Math.abs(a) * 1e-9)) diffs.push(`${name}: recorded=${a} replayed=${b}`);
    } else if (a !== b) diffs.push(`${name}: recorded=${a} replayed=${b}`);
  };
  cmp("exitPrice", trade.exitPrice, replayed.exitPrice);
  cmp("pnl", trade.pnl, replayed.pnl);
  cmp("pnlPct", trade.pnlPct, replayed.pnlPct);
  cmp("exitReason", trade.exitReason, replayed.exitReason);
  cmp("amount", trade.amount, replayed.amount);

  return {
    match: diffs.length === 0,
    reason: diffs.length === 0 ? "REPLAY_MATCH" : "REPLAY_MISMATCH",
    recorded: {
      entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
      pnl: trade.pnl, pnlPct: trade.pnlPct, exitReason: trade.exitReason, amount: trade.amount,
    },
    replayed: {
      entryPrice: replayed.entryPrice, exitPrice: replayed.exitPrice,
      pnl: replayed.pnl, pnlPct: replayed.pnlPct, exitReason: replayed.exitReason, amount: replayed.amount,
    },
    diffs,
  };
}

/** CSV export of a run's events */
export function eventsToCsv(events: TraceEvent[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = events.map((e) =>
    [e.seq, e.ts, e.runId, e.refId ?? "", e.stage, e.event, e.symbol ?? "", e.barIndex ?? "", e.candleTs ?? "", e.data ? JSON.stringify(e.data) : ""].map(esc).join(","),
  );
  return "seq,ts,runId,refId,stage,event,symbol,barIndex,candleTs,data\n" + rows.join("\n");
}
