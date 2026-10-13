import { api } from "@/infrastructure/http/api";
import { prisma } from "@/infrastructure/database/prisma";
import { getOrCreateConfig } from "@/modules/signal-factory/config";
import { marketContext } from "@/modules/signal-factory/context";
import { lastScanAt } from "@/modules/signal-factory/setups";
import { dataFresh, dataFreshCheckedAt } from "@/modules/signal-factory/data";
import { parseJson } from "@/shared/utils";

const ACTIVE_STATES = ["PROPOSED", "BACKTESTED", "WAITING_TRIGGER", "PAPER_OPEN"];

/** GET /api/signal-factory — config + BTC market context + top-10 active setups. */
export const GET = api(async (_req, ctx) => {
  const cfg = await getOrCreateConfig(ctx.userId);
  const [setups, lastScan] = await Promise.all([
    prisma.setup.findMany({
      where: { userId: ctx.userId, state: { in: ACTIVE_STATES } },
      orderBy: { score: "desc" },
      take: 10,
    }),
    lastScanAt(ctx.userId),
  ]);

  let context = null;
  let contextError: string | null = null;
  try {
    const c = await marketContext(cfg);
    const { refCandles: _drop, ...rest } = c;
    context = rest;
  } catch (e) {
    contextError = String(e instanceof Error ? e.message : e).slice(0, 200);
  }

  return {
    config: cfg,
    context,
    contextError,
    setups: setups.map((s) => ({ ...s, levelsMeta: parseJson(s.levelsMeta, {}) })),
    lastScanAt: lastScan || null,
    dataFresh: dataFresh(cfg.exchange),
    dataFreshCheckedAt: dataFreshCheckedAt(cfg.exchange),
  };
});
