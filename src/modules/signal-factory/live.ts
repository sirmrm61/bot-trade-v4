import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { AppError } from "@/shared/errors";
import { journalWrite } from "@/modules/agent/journal";
import { adapterForUser } from "@/modules/exchanges/registry";
import { checkEntryGuardrails, GUARDRAILS } from "@/modules/trading/guardrails";
import { publicAdapter } from "@/modules/exchanges/registry";
import { faNumber, faPercent, parseJson } from "@/shared/utils";
import { systemAgentId } from "./jobs";
import { transitionSetup } from "./lifecycle";
import { PAPER_STAKE_QUOTE } from "./paper";
import { COMBINED_SYMBOL } from "./backtest";
import type { ExchangeAdapter, ExchangeOrder, Ticker } from "@/modules/exchanges/types";
import type { LiveStrategy, Setup, SetupType, Trade } from "@/generated/prisma/client";

/**
 * LIVE trading — OFF by default; a SetupType reaches LIVE_SMALL only when the
 * full promotion checklist passes AND the user approves it via the API.
 *
 * Entry path: the trigger monitor calls liveEntry() on a confirmed trigger.
 * Hard gates before ANY real order:
 *   type.liveApproved + cfg.liveTradingEnabled + cfg.enabled + executable
 *   → checkEntryGuardrails (the same path every entry takes — daily loss /
 *     drawdown / SL required / R:R / score) → concurrent-position cap.
 * A guardrail veto skips the entry entirely (journaled once per reason); it
 * never falls back to paper — a vetoed live entry must not silently trade.
 *
 * Sizing: full-size baseline = the paper stake (LIVE_STAKE_QUOTE); LIVE_SMALL
 * trades at liveSizeScale=0.25. Full size requires a further explicit
 * promotion raising liveSizeScale toward 1.
 *
 * EXCHANGE-SIDE STOPS: NOT SUPPORTED. Both adapters only accept market/limit
 * OrderParams — there is no stopPrice field, so no real stop order can be
 * placed. Exits are therefore TIGHT MONITORED EXITS: live-position-manager
 * reads the ticker every minute and market-closes on SL/TP2/expiry (TP1
 * banks 50% and moves the stop to breakeven), journaling every action.
 *
 * Live positions are real Trade rows under a per-user bookkeeping
 * LiveStrategy ("SIGNAL_FACTORY", status STOPPED so liveTick never picks it
 * up) — that keeps the guardrail accounting honest and the trades visible on
 * the user's trades page. Every placed exchange order id is recorded on the
 * trade meta so the kill switch can cancel exactly our orders.
 */

export const LIVE_SMALL_SCALE = 0.25;
export const LIVE_MIN_PAPER_TRADES = 20;
export const LIVE_MIN_PAPER_DAYS = 7;
export const LIVE_STAKE_QUOTE = PAPER_STAKE_QUOTE;
const TP1_CLOSE_FRAC = 0.5;
const SF_BUCKET_STRATEGY = "__signal_factory__";
const SF_BUCKET_SYMBOL = "SIGNAL_FACTORY";

interface LiveMeta {
  signalFactory: true;
  setupId: string;
  typeKey: string;
  tp1: number;
  tp2: number;
  tp1Hit: boolean;
  sizeScale: number;
  invested0: number;
  realizedPnl: number;
  orderIds: string[];
}

// ---------------------------------------------------------------------------
// Promotion checklist — ALL conditions required, no partial credit
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  key: string;
  ok: boolean;
  labelFa: string;
}

export interface LiveChecklistResult {
  ok: boolean;
  type: SetupType | null;
  items: ChecklistItem[];
  missing: string[];
}

export async function liveChecklist(typeKey: string, userId: string): Promise<LiveChecklistResult> {
  const [type, cfg, verified] = await Promise.all([
    prisma.setupType.findUnique({ where: { key: typeKey } }),
    prisma.signalMakerConfig.findUnique({ where: { userId } }),
    prisma.setupBacktest.findFirst({
      where: { typeKey, symbol: COMBINED_SYMBOL, passed: true },
      select: { id: true },
    }),
  ]);
  const items: ChecklistItem[] = [
    { key: "BACKTEST_VERIFIED", ok: verified !== null, labelFa: "بک‌تست الگو تأییدشده (VERIFIED)" },
    {
      key: "PAPER_TRADES",
      ok: (type?.paperTrades ?? 0) >= LIVE_MIN_PAPER_TRADES,
      labelFa: `حداقل ${faNumber(LIVE_MIN_PAPER_TRADES)} معامله‌ی پیپر — فعلی ${faNumber(type?.paperTrades ?? 0)}`,
    },
    {
      key: "PAPER_DAYS",
      ok: (type?.paperDays ?? 0) >= LIVE_MIN_PAPER_DAYS,
      labelFa: `حداقل ${faNumber(LIVE_MIN_PAPER_DAYS)} روز سابقه‌ی پیپر — فعلی ${faNumber(type?.paperDays ?? 0)}`,
    },
    {
      key: "PAPER_EXPECTANCY",
      ok: (type?.paperExpectancy ?? 0) > 0,
      labelFa: `امیدوانی پیپر مثبت — فعلی ${type?.paperExpectancy == null ? "—" : faPercent(type.paperExpectancy)}`,
    },
    {
      key: "LIVE_ENABLED",
      ok: cfg?.liveTradingEnabled === true,
      labelFa: "فعال‌بودن معاملات واقعی در تنظیمات سیگنال‌ساز",
    },
  ];
  const ok = !!type && items.every((i) => i.ok);
  return { ok, type, items, missing: items.filter((i) => !i.ok).map((i) => i.labelFa) };
}

/** Explicit user approval — sets liveApproved at LIVE_SMALL size only when
 *  the full checklist passes. Idempotent for an already-approved type. */
export async function approveLive(typeKey: string, userId: string): Promise<SetupType> {
  const cl = await liveChecklist(typeKey, userId);
  if (!cl.type) throw new AppError("NOT_FOUND", 404);
  if (cl.type.liveApproved) return cl.type;
  if (!cl.ok) {
    throw new AppError("CHECKLIST_INCOMPLETE", 412, { missing: cl.missing },
      `پیش‌نیازهای ارتقا کامل نیست: ${cl.missing.join("؛ ")}`);
  }
  const updated = await prisma.setupType.update({
    where: { key: typeKey },
    data: { liveApproved: true, liveApprovedAt: new Date(), liveSizeScale: LIVE_SMALL_SCALE },
  });
  await journalWrite(
    await systemAgentId(userId), "PROMOTION_REQUEST",
    `الگوی ${updated.kind} با تأیید کاربر به «زنده محدود» ارتقا یافت — سایز ${faPercent(LIVE_SMALL_SCALE * 100)}`,
    { data: { typeKey, sizeScale: LIVE_SMALL_SCALE } },
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Guardrail bookkeeping bucket
// ---------------------------------------------------------------------------

/** Per-user LiveStrategy that exists only so checkEntryGuardrails sees the
 *  signal-factory's real trades (24h loss / drawdown / open count). Status
 *  STOPPED keeps it out of the liveTick scheduler — its trades are managed
 *  by live.ts, not live-engine. */
async function signalFactoryLive(userId: string, exchange: string): Promise<LiveStrategy> {
  const existing = await prisma.liveStrategy.findFirst({
    where: { userId, symbol: SF_BUCKET_SYMBOL },
  });
  if (existing) return existing;
  let strategy = await prisma.strategy.findFirst({
    where: { userId, name: SF_BUCKET_STRATEGY },
  });
  strategy ??= await prisma.strategy.create({
    data: { userId, name: SF_BUCKET_STRATEGY, status: "LIVE", origin: "AI" },
  });
  let version = await prisma.strategyVersion.findFirst({
    where: { strategyId: strategy.id, versionNumber: 1 },
  });
  version ??= await prisma.strategyVersion.create({
    data: {
      strategyId: strategy.id, versionNumber: 1, kind: "SIGNAL",
      symbol: SF_BUCKET_SYMBOL, timeframe: "4h",
    },
  });
  return prisma.liveStrategy.create({
    data: {
      userId, strategyId: strategy.id, versionId: version.id,
      symbol: SF_BUCKET_SYMBOL, exchange, mode: "REAL", status: "STOPPED",
      allocatedCapital: LIVE_STAKE_QUOTE,
    },
  });
}

// ---------------------------------------------------------------------------
// Live entry — called by the trigger monitor on a confirmed trigger
// ---------------------------------------------------------------------------

export type LiveEntryResult = "OPENED" | "SKIPPED" | "VETOED";

export interface LiveDeps {
  adapter?: ExchangeAdapter;
}

/** Journal a veto once per reason — the 1-min monitor must not spam. */
async function vetoOnce(setup: Setup, reason: string): Promise<void> {
  const meta = parseJson<Record<string, unknown>>(setup.meta, {});
  if (meta.liveVeto === reason) return;
  meta.liveVeto = reason;
  setup.meta = JSON.stringify(meta); // keep the caller's copy in sync
  await prisma.setup.update({ where: { id: setup.id }, data: { meta: setup.meta } });
  await journalWrite(
    await systemAgentId(setup.userId), "INCIDENT",
    `ورود زنده‌ی ستاپ ${setup.symbol} وتو شد — ${reason}`,
    { reason, data: { setupId: setup.id, typeKey: setup.typeKey } },
  );
}

async function clearVeto(setup: Setup): Promise<void> {
  const meta = parseJson<Record<string, unknown>>(setup.meta, {});
  if (!("liveVeto" in meta)) return;
  delete meta.liveVeto;
  setup.meta = JSON.stringify(meta);
  await prisma.setup.update({ where: { id: setup.id }, data: { meta: setup.meta } });
}

export async function liveEntry(setup: Setup, deps: LiveDeps = {}): Promise<LiveEntryResult> {
  const type = await prisma.setupType.findUnique({ where: { key: setup.typeKey } });
  if (!type?.liveApproved) return "SKIPPED";
  const cfg = await prisma.signalMakerConfig.findUnique({ where: { userId: setup.userId } });
  if (!cfg?.enabled || !cfg.liveTradingEnabled || !setup.executable) return "SKIPPED";

  // idempotent — one live entry per setup
  const dup = await prisma.trade.findFirst({
    where: { userId: setup.userId, meta: { contains: `"setupId":"${setup.id}"` } },
    select: { id: true },
  });
  if (dup) return "SKIPPED";

  // hard guardrails — the same checkEntryGuardrails path every entry takes
  const live = await signalFactoryLive(setup.userId, setup.exchange);
  const ref = setup.triggerPrice;
  const slPct = (Math.abs(ref - setup.sl) / ref) * 100;
  const tpPct = (Math.abs(setup.tp1 - ref) / ref) * 100;
  const verdict = await checkEntryGuardrails(live, { slPct, tpPct, score: setup.confidence });
  const openCount = verdict.allow
    ? await prisma.trade.count({ where: { liveStrategyId: live.id, status: "OPEN" } })
    : 0;
  const vetoReason = !verdict.allow
    ? verdict.reason ?? "گاردریل رد کرد"
    : openCount >= GUARDRAILS.MAX_CONCURRENT_POSITIONS
      ? `سقف ${faNumber(GUARDRAILS.MAX_CONCURRENT_POSITIONS)} پوزیشن زنده‌ی هم‌زمان`
      : null;
  if (vetoReason) {
    await vetoOnce(setup, vetoReason);
    return "VETOED";
  }
  await clearVeto(setup);

  const long = setup.direction === "LONG";
  let adapter: ExchangeAdapter;
  try {
    adapter = deps.adapter ?? (await adapterForUser(setup.userId, setup.exchange));
  } catch {
    await vetoOnce(setup, "حساب صرافی متصل نیست — سفارش واقعی ممکن نیست");
    return "VETOED";
  }
  if (setup.marketType === "FUTURES" && !adapter.createFuturesOrder) {
    await vetoOnce(setup, "adapter این صرافی سفارش فیوچرز ندارد — شورت زنده رد شد");
    return "VETOED";
  }

  const scale = type.liveSizeScale > 0 && type.liveSizeScale <= 1 ? type.liveSizeScale : LIVE_SMALL_SCALE;
  const invested = Math.round(LIVE_STAKE_QUOTE * scale * 100) / 100;
  const amount = invested / ref;
  const base = {
    symbol: setup.symbol, side: (long ? "buy" : "sell") as "buy" | "sell",
    type: "market" as const, amount, clientOrderId: `sf-${setup.id}`.slice(0, 40),
  };
  const order = setup.marketType === "FUTURES"
    ? await adapter.createFuturesOrder!({ ...base, leverage: 1, positionSide: long ? "LONG" : "SHORT" })
    : await adapter.createOrder(base);
  const entryPrice = order.avgPrice ?? order.price ?? ref;

  const meta: LiveMeta = {
    signalFactory: true, setupId: setup.id, typeKey: setup.typeKey,
    tp1: setup.tp1, tp2: setup.tp2, tp1Hit: false,
    sizeScale: scale, invested0: invested, realizedPnl: 0,
    orderIds: [order.id],
  };
  const trade = await prisma.trade.create({
    data: {
      userId: setup.userId, liveStrategyId: live.id, symbol: setup.symbol,
      side: long ? "LONG" : "SHORT", entryPrice, amount, invested,
      stopLossPrice: setup.sl, takeProfitPrice: setup.tp2,
      meta: JSON.stringify(meta),
    },
  });
  await transitionSetup(setup, "LIVE_SMALL",
    `ورود زنده با سایز ${faPercent(scale * 100)} در ${faNumber(entryPrice, true)} — سفارش واقعی ثبت شد`);
  await journalWrite(
    await systemAgentId(setup.userId), "TRADE_OPEN",
    `معامله‌ی زنده‌ی سیگنال‌ساز ${setup.symbol} ${long ? "لانگ" : "شورت"} @ ${faNumber(entryPrice, true)} — سرمایه ${faNumber(invested, true)} (${faPercent(scale * 100)} سایز) · SL ${faNumber(setup.sl, true)} · خروج مانیتورشده`,
    { data: { setupId: setup.id, tradeId: trade.id, orderId: order.id, invested, sizeScale: scale } },
  );
  return "OPENED";
}

// ---------------------------------------------------------------------------
// live-position-manager — monitored exits every 1 min (no exchange stop
// orders exist, so this monitor IS the stop-loss)
// ---------------------------------------------------------------------------

export interface LiveManagerDeps {
  adapterFor?: (userId: string, exchange: string) => Promise<ExchangeAdapter>;
  fetchTicker?: (exchange: string, symbol: string) => Promise<Ticker>;
  now?: number;
}

type ExitKind = "STOP_LOSS" | "TAKE_PROFIT" | "MANUAL";
const EXIT_OUTCOME: Record<ExitKind, string> = {
  STOP_LOSS: "SL_HIT", TAKE_PROFIT: "TP2_HIT", MANUAL: "EXPIRED",
};
const EXIT_FA: Record<ExitKind, string> = {
  STOP_LOSS: "استاپ مانیتورشده زده شد", TAKE_PROFIT: "هدف دوم زده شد", MANUAL: "انقضای ستاپ — خروج بازار",
};

async function closeLiveOrder(
  trade: Trade, setup: Setup, adapter: ExchangeAdapter, amount: number,
): Promise<ExchangeOrder> {
  const long = trade.side === "LONG";
  const base = { symbol: trade.symbol, side: (long ? "sell" : "buy") as "buy" | "sell", type: "market" as const, amount };
  return setup.marketType === "FUTURES" && adapter.createFuturesOrder
    ? adapter.createFuturesOrder({ ...base, leverage: 1, positionSide: trade.side as "LONG" | "SHORT" })
    : adapter.createOrder(base);
}

async function manageLiveTrade(
  trade: Trade,
  setup: Setup,
  adapter: ExchangeAdapter,
  price: number,
  now: number,
): Promise<"OPEN" | "CLOSED"> {
  const meta = parseJson<LiveMeta | null>(trade.meta, null);
  if (!meta) return "OPEN";
  const long = trade.side === "LONG";
  const sl = trade.stopLossPrice ?? setup.sl;
  const hitSl = long ? price <= sl : price >= sl;
  const hitTp1 = !meta.tp1Hit && (long ? price >= meta.tp1 : price <= meta.tp1);
  const hitTp2 = long ? price >= meta.tp2 : price <= meta.tp2;
  const expired = now > setup.expiresAt.getTime();

  const legPnl = (amt: number, fill: number) =>
    (long ? fill - trade.entryPrice : trade.entryPrice - fill) * amt;

  const closeAll = async (kind: ExitKind, raw: number) => {
    const o = await closeLiveOrder(trade, setup, adapter, trade.amount);
    const exitPrice = o.avgPrice ?? raw;
    const pnl = meta.realizedPnl + legPnl(trade.amount, exitPrice);
    const pnlPct = meta.invested0 > 0 ? (pnl / meta.invested0) * 100 : 0;
    const outcome = kind === "TAKE_PROFIT" ? "TP2_HIT" : meta.tp1Hit ? "TP1_HIT" : EXIT_OUTCOME[kind];
    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: "CLOSED", exitPrice, exitReason: kind, pnl, pnlPct, closedAt: new Date(now),
        meta: JSON.stringify({ ...meta, realizedPnl: pnl, orderIds: [...meta.orderIds, o.id] }),
      },
    });
    await prisma.setup.update({
      where: { id: setup.id },
      data: { outcome, outcomePnlPct: pnlPct, closedAt: new Date(now) },
    });
    await journalWrite(
      await systemAgentId(trade.userId), "TRADE_CLOSE",
      `معامله‌ی زنده‌ی سیگنال‌ساز ${trade.symbol} بسته شد — ${EXIT_FA[kind]} @ ${faNumber(exitPrice, true)} · نتیجه ${faPercent(pnlPct)}`,
      { data: { setupId: setup.id, tradeId: trade.id, exitOrderId: o.id, outcome, pnl, pnlPct } },
    );
  };

  if (hitSl || hitTp2 || expired) {
    await closeAll(hitSl ? "STOP_LOSS" : hitTp2 ? "TAKE_PROFIT" : "MANUAL",
      hitSl ? sl : hitTp2 ? meta.tp2 : price);
    return "CLOSED";
  }
  if (hitTp1) {
    const amt = trade.amount * TP1_CLOSE_FRAC;
    const inv = trade.invested * TP1_CLOSE_FRAC;
    const o = await closeLiveOrder(trade, setup, adapter, amt);
    const fill = o.avgPrice ?? meta.tp1;
    const leg = legPnl(amt, fill);
    meta.tp1Hit = true;
    meta.realizedPnl += leg;
    meta.orderIds.push(o.id);
    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        amount: trade.amount - amt, invested: trade.invested - inv,
        stopLossPrice: trade.entryPrice, // runner → breakeven
        meta: JSON.stringify(meta),
      },
    });
    await journalWrite(
      await systemAgentId(trade.userId), "TRADE_CLOSE",
      `TP1 معامله‌ی زنده ${trade.symbol} زده شد — ۵۰٪ با ${faPercent(inv > 0 ? (leg / inv) * 100 : 0)} بانک شد، استاپ به نقطه‌ی ورود منتقل شد`,
      { data: { setupId: setup.id, tradeId: trade.id, exitOrderId: o.id, legPnl: leg } },
    );
  }
  return "OPEN";
}

/** live-position-manager body (1 min). Runs regardless of config.enabled —
 *  open REAL positions must never be left unmanaged after a kill switch. */
export async function runLiveManager(deps: LiveManagerDeps = {}): Promise<{
  managed: number; closed: number; failed: number;
}> {
  const now = deps.now ?? Date.now();
  const adapterOf = deps.adapterFor ?? ((u, e) => adapterForUser(u, e));
  const fetchTicker = deps.fetchTicker ?? ((e, s) => publicAdapter(e).getTicker(s));
  const open = await prisma.trade.findMany({
    where: { status: "OPEN", meta: { contains: '"signalFactory":true' } },
  });
  const out = { managed: 0, closed: 0, failed: 0 };
  const adapterCache = new Map<string, Promise<ExchangeAdapter | null>>();
  const tickerCache = new Map<string, Promise<Ticker>>();

  for (const trade of open) {
    try {
      const meta = parseJson<LiveMeta | null>(trade.meta, null);
      const setup = meta?.setupId
        ? await prisma.setup.findUnique({ where: { id: meta.setupId } })
        : null;
      if (!setup) { out.failed++; continue; }
      const ak = `${trade.userId}|${setup.exchange}`;
      if (!adapterCache.has(ak)) adapterCache.set(ak, adapterOf(trade.userId, setup.exchange).catch(() => null));
      const adapter = await adapterCache.get(ak)!;
      if (!adapter) { out.failed++; continue; }
      const tk = `${setup.exchange}|${setup.symbol}`;
      if (!tickerCache.has(tk)) tickerCache.set(tk, fetchTicker(setup.exchange, setup.symbol));
      const ticker = await tickerCache.get(tk)!;
      out.managed++;
      if ((await manageLiveTrade(trade, setup, adapter, ticker.last, now)) === "CLOSED") out.closed++;
    } catch (e) {
      out.failed++;
      logger.warn("live manager step failed", {
        module: "signal-factory", tradeId: trade.id, symbol: trade.symbol,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kill switch — cancel our open orders, disable everything, Incident + journal
// ---------------------------------------------------------------------------

export interface KillResult {
  canceled: string[];
  failed: string[];
  adapterOk: boolean;
}

export async function killSignalFactory(
  userId: string,
  deps: { adapter?: ExchangeAdapter } = {},
): Promise<KillResult> {
  const cfg = await prisma.signalMakerConfig.findUnique({ where: { userId } });
  const adapter = deps.adapter ?? (cfg ? await adapterForUser(userId, cfg.exchange).catch(() => null) : null);

  // every order id we ever placed is recorded on the trade meta — cancel
  // exactly those still open on the exchange (never the user's other orders)
  const liveTrades = await prisma.trade.findMany({
    where: { userId, meta: { contains: '"signalFactory":true' } },
    select: { meta: true },
  });
  const known = new Set<string>();
  for (const t of liveTrades) {
    for (const id of parseJson<LiveMeta | null>(t.meta, null)?.orderIds ?? []) {
      known.add(id);
    }
  }

  const canceled: string[] = [];
  const failed: string[] = [];
  if (adapter) {
    const open = await adapter.getOpenOrders().catch(() => [] as ExchangeOrder[]);
    for (const o of open.filter((x) => known.has(x.id))) {
      if (await adapter.cancelOrder(o.id, o.symbol).catch(() => false)) canceled.push(o.id);
      else failed.push(o.id);
    }
  }
  if (cfg) {
    await prisma.signalMakerConfig.update({
      where: { userId },
      data: { enabled: false, liveTradingEnabled: false },
    });
  }
  const summary =
    `توقف اضطراری سیگنال‌ساز — ${faNumber(canceled.length)} سفارش باز لغو شد` +
    `${failed.length ? ` · ${faNumber(failed.length)} لغو ناموفق` : ""}` +
    " · سیستم و معاملات واقعی خاموش شدند";
  await prisma.incident.create({
    data: {
      userId, kind: "KILL_SWITCH", summary,
      data: JSON.stringify({ canceled, failed, adapterOk: !!adapter }),
    },
  });
  await journalWrite(await systemAgentId(userId), "INCIDENT", summary, {
    data: { canceled, failed, adapterOk: !!adapter },
  });
  return { canceled, failed, adapterOk: !!adapter };
}
