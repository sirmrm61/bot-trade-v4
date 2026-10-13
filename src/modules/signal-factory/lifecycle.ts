import { prisma } from "@/infrastructure/database/prisma";
import { logger } from "@/infrastructure/logging/logger";
import { journalWrite } from "@/modules/agent/journal";
import { publicAdapter } from "@/modules/exchanges/registry";
import { tfMs } from "@/modules/pairs/service";
import { faNumber } from "@/shared/utils";
import { dataFresh, getCandles } from "./data";
import { ruleConfirmed } from "./backtest";
import { systemAgentId } from "./jobs";
import type { Candle, Ticker } from "@/modules/exchanges/types";
import type { Prisma, Setup } from "@/generated/prisma/client";

/**
 * Setup lifecycle state machine —
 *   PROPOSED → BACKTESTED → WAITING_TRIGGER → PAPER_OPEN → PAPER_CLOSED
 *   terminals: EXPIRED | INVALIDATED | REJECTED   (LIVE_SMALL/LIVE: stage 6)
 *
 * A setup arms into WAITING_TRIGGER only while its backtest label is
 * NOT_TESTED or VERIFIED — INSUFFICIENT waits for a verdict or expires,
 * REJECTED is terminal. Drivers: latest CLOSED candle (trigger confirm),
 * ticker (pre-entry invalidation), expiresAt (expiry). Every transition
 * lands in the journal as SETUP_STATE_CHANGE with a Persian reason.
 */

export const PRE_ENTRY_STATES = ["PROPOSED", "BACKTESTED", "WAITING_TRIGGER"] as const;
export const TERMINAL_STATES = ["PAPER_CLOSED", "EXPIRED", "INVALIDATED", "REJECTED"] as const;
const TRIGGER_ELIGIBLE_LABELS = new Set(["NOT_TESTED", "VERIFIED"]);

export const STATE_FA: Record<string, string> = {
  PROPOSED: "پیشنهادی",
  BACKTESTED: "بک‌تست‌شده",
  WAITING_TRIGGER: "در انتظار تریگر",
  PAPER_OPEN: "پیپر باز",
  PAPER_CLOSED: "پیپر بسته",
  EXPIRED: "منقضی",
  INVALIDATED: "باطل‌شده",
  REJECTED: "ردشده",
  LIVE_SMALL: "زنده محدود",
  LIVE: "زنده",
};

/** Single audited transition — row update + SETUP_STATE_CHANGE journal entry. */
export async function transitionSetup(
  setup: Pick<Setup, "id" | "userId" | "symbol" | "kind" | "state">,
  to: string,
  reasonFa: string,
  opts: { data?: Record<string, unknown>; patch?: Prisma.SetupUpdateInput } = {},
): Promise<void> {
  await prisma.setup.update({
    where: { id: setup.id },
    data: {
      state: to,
      ...(to === "WAITING_TRIGGER" ? { activatedAt: new Date() } : {}),
      ...((TERMINAL_STATES as readonly string[]).includes(to) ? { closedAt: new Date() } : {}),
      ...opts.patch,
    },
  });
  await journalWrite(
    await systemAgentId(setup.userId),
    "SETUP_STATE_CHANGE",
    `ستاپ ${setup.symbol} (${setup.kind}): «${STATE_FA[setup.state] ?? setup.state}» ← «${STATE_FA[to] ?? to}»`,
    { reason: reasonFa, data: { setupId: setup.id, from: setup.state, to, ...opts.data } },
  );
}

/** Newest candle that has fully closed by `now` — never the forming one. */
export function lastClosedCandle(candles: Candle[], timeframe: string, now = Date.now()): Candle | null {
  const ms = tfMs(timeframe);
  return candles.filter((c) => c.time + ms <= now).at(-1) ?? null;
}

/** Pre-entry kill: price crossed the invalidation level. */
export function isInvalidated(
  setup: Pick<Setup, "direction" | "invalidatePrice">,
  price: number,
): boolean {
  return setup.direction === "LONG" ? price <= setup.invalidatePrice : price >= setup.invalidatePrice;
}

export interface TriggerDeps {
  fetchCandles?: (exchange: string, symbol: string, timeframe: string) => Promise<Candle[]>;
  fetchTicker?: (exchange: string, symbol: string) => Promise<Ticker>;
  now?: number;
  openPaper?: (setup: Setup) => Promise<unknown>;
  openLive?: (setup: Setup) => Promise<"OPENED" | "SKIPPED" | "VETOED">;
}

export interface TriggerMonitorResult {
  checked: number;
  promoted: number;
  opened: number;
  liveOpened: number;
  invalidated: number;
  expired: number;
  rejected: number;
  failed: number;
}

/**
 * setup-trigger-monitor body (1 min). Order per setup:
 * REJECTED label → terminal · expiresAt → EXPIRED · ticker past
 * invalidatePrice → INVALIDATED · eligible label → WAITING_TRIGGER ·
 * last closed candle confirms → live entry (LIVE_SMALL) when the pattern is
 * approved, else paper trade (PAPER_OPEN).
 */
export async function runTriggerMonitor(deps: TriggerDeps = {}): Promise<TriggerMonitorResult> {
  const now = deps.now ?? Date.now();
  const fetchCandles = deps.fetchCandles ?? ((e, s, tf) => getCandles(e, s, tf, 8));
  const fetchTicker = deps.fetchTicker ?? ((e, s) => publicAdapter(e).getTicker(s));
  // dynamic import: paper.ts and live.ts statically import transitionSetup from here
  const openPaper = deps.openPaper ?? ((s: Setup) => import("./paper").then((m) => m.openPaperTrade(s)));
  const openLive = deps.openLive ?? ((s: Setup) => import("./live").then((m) => m.liveEntry(s)));

  const setups = await prisma.setup.findMany({ where: { state: { in: [...PRE_ENTRY_STATES] } } });
  const out: TriggerMonitorResult = { checked: 0, promoted: 0, opened: 0, liveOpened: 0, invalidated: 0, expired: 0, rejected: 0, failed: 0 };

  const candleCache = new Map<string, Promise<Candle[]>>();
  const tickerCache = new Map<string, Promise<Ticker>>();
  const candlesFor = (e: string, s: string, tf: string) => {
    const k = `${e}|${s}|${tf}`;
    if (!candleCache.has(k)) candleCache.set(k, fetchCandles(e, s, tf));
    return candleCache.get(k)!;
  };
  const tickerFor = (e: string, s: string) => {
    const k = `${e}|${s}`;
    if (!tickerCache.has(k)) tickerCache.set(k, fetchTicker(e, s));
    return tickerCache.get(k)!;
  };

  for (const setup of setups) {
    try {
      out.checked++;
      if (setup.backtestLabel === "REJECTED") {
        await transitionSetup(setup, "REJECTED", "بک‌تست الگو رد شد — ستاپ به وضعیت پایانی رفت");
        out.rejected++;
        continue;
      }
      if (now > setup.expiresAt.getTime()) {
        await transitionSetup(setup, "EXPIRED",
          `انقضای ستاپ بدون فعال‌شدن تریگر ${faNumber(setup.triggerPrice, true)}`);
        out.expired++;
        continue;
      }
      // invalidation via ticker — best effort; a failed ticker never blocks the rest
      const ticker = await tickerFor(setup.exchange, setup.symbol).catch(() => null);
      if (ticker && isInvalidated(setup, ticker.last)) {
        await transitionSetup(setup, "INVALIDATED",
          `قیمت فعلی (${faNumber(ticker.last, true)}) قبل از ورود از سطح ابطال ${faNumber(setup.invalidatePrice, true)} گذشت`);
        out.invalidated++;
        continue;
      }

      if (setup.state !== "WAITING_TRIGGER") {
        if (!TRIGGER_ELIGIBLE_LABELS.has(setup.backtestLabel)) continue; // INSUFFICIENT waits for a verdict or expiry
        await transitionSetup(setup, "WAITING_TRIGGER",
          setup.backtestLabel === "VERIFIED"
            ? "بک‌تست تأییدشده — تریگر مسلح شد"
            : "تریگر مسلح شد — بک‌تست الگو در جریان/صف است");
        out.promoted++;
        setup.state = "WAITING_TRIGGER";
      }

      // trigger confirm — only on the latest CLOSED candle, never on stale data
      if (!dataFresh(setup.exchange)) continue;
      const candles = await candlesFor(setup.exchange, setup.symbol, setup.timeframe);
      const closed = lastClosedCandle(candles, setup.timeframe, now);
      if (!closed || !ruleConfirmed({
        direction: setup.direction === "SHORT" ? "SHORT" : "LONG",
        confirmRule: setup.confirmRule,
        triggerPrice: setup.triggerPrice,
        entryLow: setup.entryLow,
        entryHigh: setup.entryHigh,
        tp1: setup.tp1,
        tp2: setup.tp2,
        sl: setup.sl,
        horizonCandles: 1,
      }, closed)) continue;

      const live = await openLive(setup);
      if (live === "OPENED") { out.liveOpened++; continue; }
      if (live === "SKIPPED") {
        const trade = await openPaper(setup);
        if (trade) out.opened++;
      }
      // VETOED — guardrail blocked the real entry; stays WAITING_TRIGGER
    } catch (e) {
      out.failed++;
      logger.warn("trigger monitor step failed", {
        module: "signal-factory", setupId: setup.id, symbol: setup.symbol,
        errorCode: String(e instanceof Error ? e.message : e).slice(0, 200),
      });
    }
  }
  return out;
}
