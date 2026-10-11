import { parseJson, faPercent, faNumber } from "@/shared/utils";
import { PRICE_ACTION_SETUP_LABELS, type PriceActionSetup } from "@/shared/constants";

/**
 * Trade thesis — reconstructs WHY a trade was opened and WHAT it aimed for,
 * from the entry snapshot stored in trade.meta plus the SL/TP plan prices.
 *
 * meta shape (written by live-engine / agent open_trade):
 *   { source?: "agent", thesis?: string,
 *     signal: "BUY"|"SELL", score: number,
 *     features: {
 *       breakdown?: [{name, weight, score, contribution}]   // indicator engines
 *       label?: string                                      // symbolic engine (Persian)
 *       setup?: PriceActionSetup                            // price-action engine
 *       obiEma?: number                                     // order-book imbalance
 *       quality?: { score, regime, components }             // entry-quality gate
 *       forecast?: { p, ev, horizon }                       // model gate
 *       smartScore?: number                                 // symbolic smart layer
 *       dailyState?: "BUILDING"|"PROTECTING"|"LOCKED"|"DEFENSIVE"
 *     } }
 */

export interface TradeThesis {
  /** the plan in numbers: "هدف +۵.۲٪ · ریسک −۲.۱٪ · R:R ۲.۵" */
  plan: string | null;
  /** why the entry happened — ordered Persian bullets, most informative first */
  why: string[];
  /** who made the call */
  source: "agent" | "signal" | "manual";
}

const REGIME_FA: Record<string, string> = {
  trending: "رونددار",
  ranging: "رنج",
  volatile: "پرنوسان",
};

const DAILY_FA: Record<string, string> = {
  BUILDING: "در حال ساخت",
  PROTECTING: "محافظت از سود",
  LOCKED: "قفل",
  DEFENSIVE: "دفاعی",
};

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${faPercent(Math.abs(n))}`;

interface ThesisTrade {
  side: string;
  entryPrice: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  meta: string | null;
}

export function tradeThesis(t: ThesisTrade): TradeThesis {
  const meta = parseJson<{
    source?: string;
    thesis?: string;
    signal?: string;
    score?: number;
    features?: Record<string, unknown>;
  }>(t.meta ?? "{}", {});

  const long = t.side !== "SHORT";
  const pct = (price: number) =>
    ((long ? price - t.entryPrice : t.entryPrice - price) / t.entryPrice) * 100;

  // ---- the plan: what the trade was aiming for, in numbers
  let plan: string | null = null;
  const tpPct = t.takeProfitPrice ? pct(t.takeProfitPrice) : null;
  const slPct = t.stopLossPrice ? pct(t.stopLossPrice) : null;
  if (tpPct !== null || slPct !== null) {
    const parts: string[] = [];
    if (tpPct !== null) parts.push(`هدف ${signed(tpPct)}`);
    if (slPct !== null) parts.push(`ریسک ${signed(slPct)}`);
    if (tpPct !== null && slPct !== null && Math.abs(slPct) > 0)
      parts.push(`R:R ${faNumber(Math.abs(tpPct / slPct), true)}`);
    plan = parts.join(" · ");
  }

  // ---- the why: ordered evidence from the entry snapshot
  const why: string[] = [];
  const f = meta.features ?? {};

  if (typeof meta.thesis === "string" && meta.thesis.trim())
    why.push(meta.thesis.trim());

  if (typeof f.label === "string" && f.label) why.push(`ساختار: ${f.label}`);
  if (typeof f.setup === "string")
    why.push(`ستاپ: ${PRICE_ACTION_SETUP_LABELS[f.setup as PriceActionSetup] ?? f.setup}`);
  if (typeof f.obiEma === "number")
    why.push(`عدم تعادل دفتر سفارش: ${faNumber(f.obiEma, true)}`);

  const breakdown = f.breakdown;
  if (Array.isArray(breakdown) && breakdown.length) {
    const top = [...breakdown]
      .filter((b) => typeof b?.contribution === "number")
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 2)
      .map((b) => `${b.name} (${b.contribution > 0 ? "+" : ""}${faNumber(b.contribution, true)})`);
    if (top.length) why.push(`محرک‌ها: ${top.join("، ")}`);
  }

  const q = f.quality as { score?: number; regime?: string } | undefined;
  if (q && typeof q.score === "number") {
    const regime = q.regime ? ` · رژیم ${REGIME_FA[q.regime] ?? q.regime}` : "";
    why.push(`امتیاز ورود ${faPercent(q.score * 100)}${regime}`);
  }

  const fc = f.forecast as { p?: number; ev?: number; horizon?: string } | undefined;
  if (fc && typeof fc.p === "number")
    why.push(
      `پیش‌بینی مدل ${faPercent(fc.p * 100)}${fc.horizon ? ` (افق ${fc.horizon})` : ""}` +
      (typeof fc.ev === "number" ? ` · EV ${signed(fc.ev)}` : ""),
    );

  if (typeof f.smartScore === "number")
    why.push(`امتیاز هوشمند ${faPercent(f.smartScore * 100)}`);

  if (typeof f.dailyState === "string" && DAILY_FA[f.dailyState])
    why.push(`وضعیت روز هنگام ورود: ${DAILY_FA[f.dailyState]}`);

  if (typeof meta.score === "number" && !q)
    why.push(`قدرت سیگنال ${faPercent(meta.score * 100)}`);

  const source: TradeThesis["source"] =
    meta.source === "agent" ? "agent" : meta.thesis ? "manual" : "signal";

  return { plan, why, source };
}
