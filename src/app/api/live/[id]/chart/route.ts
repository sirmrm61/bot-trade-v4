import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { getCandles, tfMs } from "@/modules/pairs/service";
import { loadBacktestChart } from "@/modules/backtest/chart-data";
import { parseJson } from "@/shared/utils";
import { isSymbolicKind } from "@/modules/trading/symbolic-engines";
import { AppError } from "@/shared/errors";
import type {
  ChartCandle, TradeMark, OverlaySeries, OscillatorSeries, SignalMark, PriceLevel,
} from "@/components/candle-chart";

const CANDLES = 150;

interface LiveStats {
  obiHist?: { t: number; v: number }[];
  paper?: {
    quotes?: { side: string; price: number; amount: number }[];
    fillsLog?: { t: number; side: string; price: number }[];
    pnlHist?: { t: number; v: number }[];
  };
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
    const raw = await getCandles({ symbol: live.symbol, timeframe, start, end }).catch(() => []);
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

  return { candles, overlays, oscillators, signals, levels, trades: tradeMarks, kind, mode: live.mode };
});
