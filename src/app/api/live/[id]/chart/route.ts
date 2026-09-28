import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { loadBacktestChart } from "@/modules/backtest/chart-data";
import { faNumber, parseJson } from "@/shared/utils";
import {
  isSymbolicKind, readAtmSmeConfig, readRmmBseConfig, readDzsHmmConfig,
} from "@/modules/trading/symbolic-engines";
import { readMmConfig } from "@/modules/trading/market-making";
import { readMarketConfig, liquidationPrice } from "@/modules/trading/futures";
import { AppError } from "@/shared/errors";
import type {
  ChartCandle, TradeMark, OverlaySeries, OscillatorSeries, SignalMark, PriceLevel,
} from "@/components/candle-chart";

const CANDLES = 150;

interface LiveStats {
  lastScore?: number;
  lastSignal?: string;
  symLabel?: string;
  mid?: number;
  obiHist?: { t: number; v: number }[];
  paper?: {
    quotes?: { side: string; price: number; amount: number }[];
    fillsLog?: { t: number; side: string; price: number }[];
    pnlHist?: { t: number; v: number }[];
  };
}

interface WatchLine {
  tone: "buy" | "sell" | "info";
  text: string;
}

/** Live "when does it trade" explainer — shown beside the current price on /live. */
export interface SignalWatch {
  price: number | null;
  signal: string;
  score: number | null;
  label: string | null;
  state: string;
  lines: WatchLine[];
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Per-kind Persian explanation of the entry/exit triggers with live values. */
function buildWatch(
  kind: string,
  version: {
    config: string;
    buyThreshold: number;
    sellThreshold: number;
    stopLossPct: number;
    takeProfitPct: number;
    trailingStop: boolean;
    trailingStopPct: number | null;
  },
  stats: LiveStats,
  lastClose: number | null,
): SignalWatch {
  const signal = stats.lastSignal ?? "HOLD";
  const score = typeof stats.lastScore === "number" ? round(stats.lastScore) : null;
  const label = stats.symLabel ?? null;
  const lines: WatchLine[] = [];
  const marketCfg = readMarketConfig(version.config);
  const futures = marketCfg.market === "FUTURES";
  let price = lastClose;

  if (kind === "MARKET_MAKING") {
    const cfg = readMmConfig(version.config);
    const mid = stats.mid ?? lastClose;
    price = mid;
    if (mid && mid > 0) {
      const off = cfg.spreadPct / 200;
      lines.push({ tone: "buy", text: `خرید: قیمت به کوت خرید یعنی ${faNumber(mid * (1 - off), true)} برسد — ${cfg.spreadPct / 2}٪ زیر قیمت میانی` });
      lines.push({ tone: "sell", text: `فروش: قیمت به کوت فروش یعنی ${faNumber(mid * (1 + off), true)} برسد — ${cfg.spreadPct / 2}٪ بالای قیمت میانی` });
      lines.push({ tone: "info", text: `مارکت‌میکر دائماً دوطرفه کوت می‌گذارد؛ ورود با فیل شدن هر کوت اتفاق می‌افتد و با ${cfg.levels} سطح با فاصله ${cfg.levelStepPct}٪ پوشش داده می‌شود` });
    }
  } else if (kind === "ATM_SME") {
    const cfg = readAtmSmeConfig(version.config);
    lines.push({ tone: "buy", text: `ورود به خرید: الگوی خستگی فروش [E,E,C] یا [E,E,D] روی توکن‌ها${cfg.useEmaConfirm ? ` + قیمت بالای EMA(${cfg.emaPeriod})` : ""}` });
    lines.push({ tone: "sell", text: `خروج: الگوی [A,A,C]/[A,A,B] یا افت مومنتوم از ${cfg.exitTrigger} به زیر ${cfg.exitBack}` });
    if (score !== null) lines.push({ tone: "info", text: `Vt فعلی ${score} — ناحیه خرید وقتی توکن‌ها از E (زیر ${-cfg.tokenExtreme}) به C بازیابی شوند` });
  } else if (kind === "RMM_BSE") {
    const cfg = readRmmBseConfig(version.config);
    lines.push({ tone: "buy", text: `ورود به خرید: شکست سقف کانال ${cfg.channelLen} کندله — Mt ≥ ${cfg.breakoutMt}${cfg.useVolumeConfirm ? ` + حجم ≥ ${cfg.volMult}× میانگین` : ""}` });
    lines.push({ tone: "sell", text: `خروج: Mt < ${cfg.exitMt} (برگشت به داخل کانال)` });
    if (score !== null) lines.push({ tone: "info", text: `Mt فعلی ${score} — فاصله تا ناحیه شکست: ${round(cfg.breakoutMt - score)}` });
  } else if (kind === "DZS_HMM") {
    const cfg = readDzsHmmConfig(version.config);
    lines.push({ tone: "buy", text: `ورود به خرید: P(صعودی) ≥ ${cfg.bullProb}${cfg.persist > 1 ? ` برای ${cfg.persist} کندل متوالی` : ""}` });
    lines.push({ tone: "sell", text: `خروج: P(رنج) ≥ ${cfg.rangeProbExit} یا P(نزولی) ≥ ${cfg.bearProbExit}` });
    if (score !== null) lines.push({ tone: "info", text: `تراز رژیم فعلی (صعودی منهای نزولی): ${score}` });
  } else {
    // SIGNAL + ORDER_BOOK_IMBALANCE — score crossing the configured thresholds
    const metric = kind === "ORDER_BOOK_IMBALANCE" ? "OBI هموارشده" : "امتیاز ترکیبی اندیکاتورها";
    const gap = score !== null && score < version.buyThreshold
      ? ` — فاصله تا ماشه: ${round(version.buyThreshold - score)}`
      : "";
    lines.push({ tone: "buy", text: `ورود به ${futures ? "لانگ" : "خرید"}: ${metric} ≥ ${version.buyThreshold} (اکنون ${score ?? "—"}${gap})` });
    lines.push({
      tone: "sell",
      text: futures
        ? `ورود به شورت: ${metric} ≤ ${version.sellThreshold} (سیگنال مخالف، پوزیشن باز را هم می‌بندد)`
        : `سیگنال فروش: ${metric} ≤ ${version.sellThreshold}`,
    });
  }

  if (kind !== "MARKET_MAKING") {
    if (futures) {
      const liq = price ? liquidationPrice(price, "LONG", marketCfg.leverage) : null;
      lines.push({
        tone: "info",
        text: `بازار پرپچوال — لورج ${marketCfg.leverage}× · شورت روی سیگنال فروش · لیکوییدیشن ≈ ${liq ? faNumber(liq) : "—"} (لانگ از قیمت فعلی)`,
      });
    }
    lines.push({
      tone: "info",
      text: `${futures ? "لانگ و شورت" : "فقط پوزیشن لانگ"} — بستن معامله با حد ضرر ${version.stopLossPct}٪، حد سود ${version.takeProfitPct}٪${version.trailingStop && version.trailingStopPct ? ` یا تریلینگ ${version.trailingStopPct}٪` : ""}${futures ? " یا لیکوییدیشن" : ""} انجام می‌شود`,
    });
  }

  const state = signal === "BUY" ? "سیگنال خرید برقرار است"
    : signal === "SELL" ? "سیگنال فروش برقرار است"
    : "در انتظار شرایط ورود";
  return { price, signal, score, label, state, lines };
}

/** Value of candle i = last sample within its time window (forward-fill). */
function alignToCandles(hist: { t: number; v: number }[], candles: ChartCandle[], tf: number): number[] {
  const values = new Array<number>(candles.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    while (j < hist.length && hist[j].t <= candles[i].time + tf) j++;
    if (j > 0) values[i] = hist[j - 1].v;
  }
  return values;
}

const quoteLevel = (side: string, price: number): PriceLevel => ({
  price,
  color: side === "BUY" ? "#16a34a" : "#dc2626",
  label: side === "BUY" ? "کوت خرید" : "کوت فروش",
});

/** Live chart payload — polled by the LiveChart client component on /live. */
export const GET = api(async (_req, ctx) => {
  const live = await prisma.liveStrategy.findFirst({
    where: { id: ctx.params!.id, userId: ctx.userId },
    include: { version: { include: { indicators: { orderBy: { sortOrder: "asc" } } } } },
  });
  if (!live || !live.version) throw new AppError("NOT_FOUND", 404);

  const kind = live.version.kind ?? "SIGNAL";
  // order-book kinds tick on order-flow — 1m candles make the live action visible;
  // symbolic engines are candle-native and keep the version timeframe
  const timeframe = ["ORDER_BOOK_IMBALANCE", "MARKET_MAKING"].includes(kind) ? "1m" : live.version.timeframe;
  const tf = tfMs(timeframe);
  const end = new Date();
  const start = new Date(end.getTime() - CANDLES * tf);

  const trades = await prisma.trade.findMany({
    where: { liveStrategyId: live.id },
    orderBy: { openedAt: "asc" },
    take: 200,
  });
  const tradeMarks: TradeMark[] = trades.map((t) => ({
    entryTime: t.openedAt.getTime(),
    exitTime: t.closedAt?.getTime() ?? null,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    exitReason: t.exitReason,
  }));

  let candles: ChartCandle[] = [];
  let overlays: OverlaySeries[] = [];
  let oscillators: OscillatorSeries[] = [];
  let signals: SignalMark[] = [];

  if (kind === "SIGNAL" || isSymbolicKind(kind)) {
    // same rendering pipeline as the backtest chart — indicators + signal diamonds
    // (symbolic kinds render their engine pane + entry/exit marks)
    const r = await loadBacktestChart(
      { symbol: live.symbol, timeframe, startDate: start, endDate: end },
      live.version.indicators,
      {
        maxCandles: CANDLES,
        buyThreshold: live.version.buyThreshold,
        sellThreshold: live.version.sellThreshold,
        indicatorConfigs: live.version.indicators,
        kind,
        config: live.version.config,
      },
    );
    ({ candles, overlays, oscillators, signals } = r);
  } else {
    const raw = await getCandles({ symbol: live.symbol, timeframe, start, end, exchange: live.exchange }).catch(() => []);
    candles = raw.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
  }

  const stats = parseJson<LiveStats>(live.stats, {});

  // trigger levels — prices where a fill/exit happens on touch
  const levels: PriceLevel[] = [];
  for (const t of trades) {
    if (t.status !== "OPEN") continue;
    levels.push({ price: t.entryPrice, color: "#64748b", label: "ورود" });
    if (t.stopLossPrice) levels.push({ price: t.stopLossPrice, color: "#dc2626", label: "حد ضرر" });
    if (t.takeProfitPrice) levels.push({ price: t.takeProfitPrice, color: "#0d9488", label: "حد سود" });
    if (live.version.trailingStop && live.version.trailingStopPct && t.trailingPeak && t.trailingPeak > t.entryPrice) {
      levels.push({
        price: t.trailingPeak * (1 - live.version.trailingStopPct / 100),
        color: "#f59e0b",
        label: "تریلینگ",
      });
    }
  }

  if (kind === "ORDER_BOOK_IMBALANCE" && stats.obiHist?.length && candles.length) {
    oscillators.push({
      name: "OBI",
      kind: "line",
      values: alignToCandles(stats.obiHist, candles, tf),
      // score thresholds — a trade fires when OBI crosses these
      bands: [
        { v: live.version.buyThreshold, color: "#16a34a", label: "آستانه خرید" },
        { v: live.version.sellThreshold, color: "#dc2626", label: "آستانه فروش" },
      ],
    });
  }

  if (kind === "MARKET_MAKING") {
    if (live.mode === "PAPER") {
      const paper = stats.paper;
      for (const q of (paper?.quotes ?? []).slice(0, 10)) {
        levels.push(quoteLevel(q.side, q.price));
      }
      for (const f of paper?.fillsLog ?? []) {
        signals.push({ time: f.t, price: f.price, type: f.side === "BUY" ? "BUY" : "SELL" });
      }
      if (paper?.pnlHist?.length && candles.length) {
        oscillators.push({ name: "PnL تست", kind: "line", values: alignToCandles(paper.pnlHist, candles, tf) });
      }
    } else {
      const openOrders = await prisma.order.findMany({
        where: {
          liveStrategyId: live.id,
          status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
          price: { not: null },
        },
        orderBy: { price: "asc" },
      });
      for (const o of openOrders.slice(0, 10)) {
        levels.push(quoteLevel(o.side, o.price!));
      }
      const filledOrders = await prisma.order.findMany({
        where: { liveStrategyId: live.id, status: "FILLED" },
        orderBy: { closedAt: "desc" },
        take: 100,
      });
      for (const o of filledOrders) {
        if (o.closedAt && o.avgFillPrice) {
          signals.push({ time: o.closedAt.getTime(), price: o.avgFillPrice, type: o.side === "BUY" ? "BUY" : "SELL" });
        }
      }
    }
  }

  const lastClose = candles.length ? candles[candles.length - 1].close : null;
  const watch = buildWatch(kind, live.version, stats, lastClose);

  return { candles, overlays, oscillators, signals, levels, trades: tradeMarks, kind, mode: live.mode, watch };
});
