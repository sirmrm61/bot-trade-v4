import { prisma } from "@/infrastructure/database/prisma";
import { AppError } from "@/shared/errors";
import { rankPairs } from "@/modules/scalping/service";
import { publicAdapter } from "@/modules/exchanges/registry";
import { notify } from "@/modules/notifications/service";
import { logActivity } from "@/modules/activity/service";
import { logger } from "@/infrastructure/logging/logger";
import { clamp } from "@/shared/utils";
import { detectWhales, WHALE_DEFAULTS, type WhaleConfig } from "./engine";

/**
 * Whale Watch — scans the order books of the scanner's top-ranked pairs and
 * persists whale walls / depth imbalances as WhaleEvents.
 */

const MAX_BOOK_FETCHES = 15;
const NOTIFY_SCORE = 70; // strong events ping the user

export async function scanWhales(
  userId: string,
  opts: { market?: "SPOT" | "PERPETUAL"; count?: number; cfg?: Partial<WhaleConfig> } = {},
) {
  const count = clamp(Math.trunc(opts.count ?? 10), 1, 25);
  const cfg: WhaleConfig = { ...WHALE_DEFAULTS, ...opts.cfg };

  const ranked = (await rankPairs({ market: opts.market })).pairs
    .filter((p) => p.status === "RANKED")
    .slice(0, MAX_BOOK_FETCHES);
  if (ranked.length === 0) {
    throw new AppError("INSUFFICIENT_DATA", 422, { reason: "no ranked pairs" });
  }

  const events: { p: (typeof ranked)[number]; calcs: ReturnType<typeof detectWhales> }[] = [];
  for (const p of ranked) {
    try {
      const book = await publicAdapter(p.exchange).getOrderBook(p.symbol);
      const calcs = detectWhales(book, cfg);
      if (calcs.length) events.push({ p, calcs });
    } catch {
      logger.warn("whale book fetch failed", { module: "whales", symbol: p.symbol });
    }
  }

  const flat = events
    .flatMap(({ p, calcs }) => calcs.map((c) => ({ p, c })))
    .sort((a, b) => b.c.score - a.c.score)
    .slice(0, count);

  const created = [];
  for (const { p, c } of flat) {
    created.push(await prisma.whaleEvent.create({
      data: {
        userId, exchange: p.exchange, symbol: p.symbol,
        marketType: p.marketType, kind: c.kind,
        mid: c.mid, price: c.price, sizeUsd: c.sizeUsd,
        distancePct: c.distancePct, sharePct: c.sharePct,
        bidDepthUsd: c.bidDepthUsd, askDepthUsd: c.askDepthUsd,
        imbalance: Number.isFinite(c.imbalance) ? c.imbalance : 999,
        score: c.score, reasons: JSON.stringify(c.reasons),
        features: JSON.stringify({ depthLevels: cfg.depthLevels, scanScore: p.score }),
      },
    }));
  }

  // notify on the single strongest event — avoid spamming per level
  const strongest = flat[0];
  if (strongest && strongest.c.score >= NOTIFY_SCORE) {
    void notify({
      userId, type: "SYSTEM", severity: "WARNING",
      title: "ردیاب نهنگ — رویداد قوی",
      body: `${strongest.p.symbol}: ${strongest.c.reasons[0]}`,
    }).catch(() => {});
  }

  await logActivity({ userId, action: "WHALE_SCAN", entityType: "whaleEvent" });
  logger.info("whale scan", { module: "whales", userId, scanned: ranked.length, found: created.length });
  return { scanned: ranked.length, found: created.length, events: created };
}
