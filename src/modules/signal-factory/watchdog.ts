import { prisma } from "@/infrastructure/database/prisma";
import { publicAdapter } from "@/modules/exchanges/registry";
import { logger } from "@/infrastructure/logging/logger";
import { configTimeframes, pairFilter, pairVolume24h } from "./config";
import { isStale, markDataFresh } from "./data";
import { systemAgentId } from "./jobs";
import { journalWrite } from "@/modules/agent/journal";

/**
 * Data-freshness watchdog — for every enabled config: probe adapter
 * connectivity (getTicker on a live pair) and candle freshness for the top
 * liquid symbols. Failure ⇒ markDataFresh(false) so setup production is
 * skipped, plus an Incident + journal entry per affected user. Incidents are
 * deduplicated: one per user per 30 min while an outage persists.
 */

const INCIDENT_COOLDOWN_MS = 30 * 60_000;
const TOP_SYMBOLS = 5;

export async function runDataFreshnessWatchdog(): Promise<void> {
  const configs = await prisma.signalMakerConfig.findMany({ where: { enabled: true } });
  const exchanges = [...new Set(configs.map((c) => c.exchange))];

  for (const exchange of exchanges) {
    const cfgs = configs.filter((c) => c.exchange === exchange);
    try {
      const adapter = publicAdapter(exchange);
      for (const cfg of cfgs) {
        const pairs = await pairFilter(cfg);
        if (!pairs.length) continue; // no candidates — nothing to go stale on
        await adapter.getTicker(pairs[0].symbol); // connectivity probe
        const tf = configTimeframes(cfg)[0];
        const top = [...pairs].sort((a, b) => pairVolume24h(b) - pairVolume24h(a)).slice(0, TOP_SYMBOLS);
        for (const p of top) {
          const candles = await adapter.getCandles(p.symbol, tf, undefined, 5);
          if (isStale(candles, tf)) {
            throw new Error(`داده کهنه: ${p.symbol} (${tf})`);
          }
        }
      }
      markDataFresh(exchange, true);
    } catch (e) {
      markDataFresh(exchange, false);
      const detail = String(e instanceof Error ? e.message : e).slice(0, 500);
      logger.error("data freshness watchdog — stale/unreachable", {
        module: "signal-factory", exchange, errorCode: detail,
      });
      for (const cfg of cfgs) {
        const recent = await prisma.incident.findFirst({
          where: { userId: cfg.userId, kind: "DATA_FRESHNESS", createdAt: { gte: new Date(Date.now() - INCIDENT_COOLDOWN_MS) } },
          select: { id: true },
        });
        if (recent) continue;
        await prisma.incident.create({
          data: {
            userId: cfg.userId,
            kind: "DATA_FRESHNESS",
            summary: `داده‌ی ${exchange} کهنه است یا صرافی در دسترس نیست — تولید ستاپ متوقف شد`,
            data: JSON.stringify({ exchange, error: detail }),
          },
        });
        await journalWrite(
          await systemAgentId(cfg.userId), "INCIDENT",
          `واچ‌داگ داده: ${exchange} کهنه/قطع — تولید ستاپ متوقف شد`,
          { reason: detail },
        );
      }
    }
  }
}
