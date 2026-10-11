import { api } from "@/infrastructure/http/api";
import { rankPairs } from "@/modules/scalping/service";
import { CRITERION_KEYS } from "@/modules/scalping/config";

const num = (v: string | null) => (v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** GET /api/scalping — ranked scalping-suitability scan of configured markets. */
export const GET = api(async (req) => {
  const q = new URL(req.url).searchParams;
  const weights: Record<string, number> = {};
  for (const k of CRITERION_KEYS) {
    const v = num(q.get(`w_${k}`));
    if (v !== undefined) weights[k] = v;
  }
  return rankPairs({
    exchange: q.get("exchange") || undefined,
    quote: q.get("quote") || "USDT",
    market: q.get("market") || "all",
    base: q.get("base") || undefined,
    minVolumeUsd: num(q.get("minVolumeUsd")),
    orderSizeUsd: num(q.get("orderSizeUsd")),
    leverage: num(q.get("leverage")),
    costMode: q.get("costMode") || undefined,
    makerFeePct: num(q.get("makerFeePct")),
    candleTimeframe: q.get("candleTimeframe") || undefined,
    bookLimit: num(q.get("bookLimit")),
    feePctPerSide: num(q.get("feePct")),
    includeExcluded: q.get("includeExcluded") !== "0",
    weights,
  });
});
