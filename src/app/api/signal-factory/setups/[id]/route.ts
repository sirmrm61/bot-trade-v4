import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { getCandles } from "@/modules/signal-factory/data";
import { COMBINED_SYMBOL } from "@/modules/signal-factory/backtest";
import { parseJson } from "@/shared/utils";

/** GET /api/signal-factory/setups/[id] — detail for the dialog: parsed
 *  levelsMeta provenance, paper trade, pooled backtest verdict, lifecycle
 *  history (journal events carrying this setupId), and a sparkline series
 *  from the exchange's own candles. */
export const GET = api(async (_req, ctx) => {
  const setup = await prisma.setup.findFirst({
    where: { id: ctx.params!.id, userId: ctx.userId },
    include: { paperTrade: true },
  });
  if (!setup) throw new AppError("NOT_FOUND", 404);

  const agent = await prisma.tradingAgent.findFirst({
    where: { userId: setup.userId, symbol: "SIGNAL_FACTORY" },
    select: { id: true },
  });
  const [backtests, history, candles] = await Promise.all([
    prisma.setupBacktest.findMany({
      where: { setupId: setup.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    agent
      ? prisma.agentJournal.findMany({
          where: {
            agentId: agent.id,
            type: { in: ["SETUP_STATE_CHANGE", "PAPER_TRADE", "BACKTEST"] },
            data: { contains: setup.id },
          },
          orderBy: { createdAt: "asc" },
          take: 50,
        })
      : [],
    getCandles(setup.exchange, setup.symbol, setup.timeframe, 60).catch(() => []),
  ]);

  const combined = backtests.find((b) => b.symbol === COMBINED_SYMBOL) ?? null;
  return {
    setup: {
      ...setup,
      levelsMeta: parseJson<Record<string, string>>(setup.levelsMeta, {}),
      paperTrade: setup.paperTrade
        ? { ...setup.paperTrade, meta: parseJson(setup.paperTrade.meta, null) }
        : null,
    },
    backtest: combined
      ? {
          passed: combined.passed,
          reasons: parseJson<string[]>(combined.reasons, []),
          train: parseJson(combined.trainMetrics, null),
          test: parseJson(combined.testMetrics, null),
          feePct: combined.feePct,
          slippagePct: combined.slippagePct,
          startDate: combined.startDate,
          endDate: combined.endDate,
        }
      : null,
    peers: backtests
      .filter((b) => b.symbol !== COMBINED_SYMBOL)
      .map((b) => ({ symbol: b.symbol, passed: b.passed, test: parseJson(b.testMetrics, null) })),
    history: history.map((h) => ({
      at: h.createdAt, type: h.type, summary: h.summary, reason: h.reason,
    })),
    sparkline: candles.slice(-60).map((c) => c.close),
  };
});
