"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, HelpTip, Input, Select } from "@/components/client";
import { toast } from "@/components/toast";
import { TIMEFRAMES, STRATEGY_KINDS, STRATEGY_KIND_LABELS, type StrategyKind } from "@/shared/constants";
import { INDICATORS, INDICATOR_MAP } from "@/modules/indicators/registry";

/**
 * Strategy Builder — client form producing the StrategyInput JSON.
 * Indicator cards are generated from the indicator registry.
 */

interface IndicatorState {
  enabled: boolean;
  weight: number;
  params: Record<string, number>;
  buyOp: string;
  buyValue: number;
  sellOp: string;
  sellValue: number;
}

const DEFAULTS: Record<string, IndicatorState> = Object.fromEntries(
  INDICATORS.map((d) => [d.key, {
    enabled: d.defaultEnabled,
    weight: d.defaultWeight,
    params: { ...d.defaultParams },
    buyOp: d.defaultBuyCondition?.op ?? "lt",
    buyValue: d.defaultBuyCondition?.value ?? 0,
    sellOp: d.defaultSellCondition?.op ?? "gt",
    sellValue: d.defaultSellCondition?.value ?? 0,
  }]),
);

const IND_LABELS: Record<string, string> = Object.fromEntries(INDICATORS.map((d) => [d.key, d.label]));
const PARAM_LABELS: Record<string, string> = {
  period: "دوره", fastPeriod: "سریع", slowPeriod: "کند", signalPeriod: "سیگنال",
  stdDev: "انحراف معیار", kPeriod: "K", dPeriod: "D", smoothing: "هموارسازی",
  slMultiplier: "ضریب حد ضرر", tpMultiplier: "ضریب حد سود",
};

const OPS = [
  { value: "lt", label: "کمتر از" }, { value: "gt", label: "بیشتر از" },
  { value: "lte", label: "کمتر/مساوی" }, { value: "gte", label: "بیشتر/مساوی" },
  { value: "cross_above", label: "عبور به بالا" }, { value: "cross_below", label: "عبور به پایین" },
];

/** Candle-native symbolic engines — generic score thresholds don't apply to them. */
const SYMBOLIC = new Set(["ATM_SME", "RMM_BSE", "DZS_HMM"]);
const showThresholds = (k: StrategyKind) => k === "SIGNAL" || k === "ORDER_BOOK_IMBALANCE";
/** kinds the market-aware suggester can fill (all except hand-tuned indicator mixes). */
const SUGGESTABLE = new Set(["ORDER_BOOK_IMBALANCE", "MARKET_MAKING", "ATM_SME", "RMM_BSE", "DZS_HMM"]);

const RISK_OPTIONS = [
  { value: "LOW", label: "محافظه‌کار — سیگنال کمتر، اطمینان بیشتر" },
  { value: "MEDIUM", label: "متعادل" },
  { value: "HIGH", label: "تهاجمی — سیگنال بیشتر، ریسک بالاتر" },
];

export function StrategyBuilder({
  endpoint, method = "POST", submitLabel = "ذخیره استراتژی", initial, pairs,
}: {
  endpoint: string;
  method?: string;
  submitLabel?: string;
  pairs: { symbol: string }[];
  initial?: {
    name: string; description?: string | null; symbol: string; timeframe: string;
    kind?: StrategyKind;
    buyThreshold: number; sellThreshold: number; riskPerTradePct: number;
    stopLossPct: number; takeProfitPct: number; trailingStop: boolean;
    trailingStopPct?: number | null; maxPositionPct: number; orderType: string;
    indicators: { name: string; parameters: string; weight: number; enabled: boolean; buyCondition: string; sellCondition: string }[];
    market?: "SPOT" | "FUTURES"; leverage?: number;
  };
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<StrategyKind>(initial?.kind ?? "SIGNAL");
  const [market, setMarket] = useState<"SPOT" | "FUTURES">(initial?.market ?? "SPOT");
  const [risk, setRisk] = useState<"LOW" | "MEDIUM" | "HIGH">("MEDIUM");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNotes, setSuggestNotes] = useState<string[]>([]);

  /** write suggested values onto the uncontrolled inputs/selects/checkboxes by name.
   *  Returns the count of fields actually applied so failures are visible. */
  function applyFields(fields: Record<string, number | string | boolean>) {
    const form = formRef.current;
    let applied = 0;
    if (!form) return applied;
    for (const [k, v] of Object.entries(fields)) {
      const el = form.elements.namedItem(k);
      if (el instanceof HTMLInputElement) {
        if (el.type === "checkbox") el.checked = Boolean(v);
        else el.value = String(v);
        applied++;
      } else if (el instanceof HTMLSelectElement) {
        el.value = String(v);
        applied++;
      }
    }
    return applied;
  }

  async function suggest() {
    const form = formRef.current;
    if (!form) return;
    const symbol = String((form.elements.namedItem("symbol") as HTMLSelectElement)?.value ?? "");
    const timeframe = String((form.elements.namedItem("timeframe") as HTMLSelectElement)?.value ?? "15m");
    if (!symbol) {
      toast.error("ابتدا نماد را انتخاب کنید.");
      return;
    }
    setSuggesting(true);
    setSuggestNotes([]);
    try {
      const res = await fetch("/api/strategies/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe, kind, risk }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "پیشنهاد پارامتر ناموفق بود");
        return;
      }
      const fields = (json.fields ?? {}) as Record<string, number | string | boolean>;
      const applied = applyFields(fields);
      setSuggestNotes(json.notes ?? []);
      // surface any field the browser still considers invalid (min/max) instead of a silent bad submit
      const invalid = Object.keys(fields).filter((k) => {
        const el = form.elements.namedItem(k);
        return el instanceof HTMLInputElement && !el.checkValidity();
      });
      if (invalid.length) {
        toast.error(`${applied} پارامتر اعمال شد ولی ${invalid.length} مورد خارج از بازه‌ی مجاز است: ${invalid.join(", ")}`);
      } else {
        toast.success(`${applied} پارامتر بر اساس وضعیت فعلی بازار پیشنهاد و اعمال شد — قبل از ذخیره بازبینی کنید.`);
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
    } finally {
      setSuggesting(false);
    }
  }

  const [inds, setInds] = useState<Record<string, IndicatorState>>(() => {
    if (!initial) return DEFAULTS;
    const out = { ...DEFAULTS };
    for (const i of initial.indicators) {
      if (!INDICATOR_MAP.has(i.name.toUpperCase())) continue;
      const params = JSON.parse(i.parameters || "{}");
      const buy = JSON.parse(i.buyCondition || "{}");
      const sell = JSON.parse(i.sellCondition || "{}");
      out[i.name] = {
        enabled: i.enabled,
        weight: i.weight,
        params: { ...DEFAULTS[i.name]?.params, ...params },
        buyOp: buy.op ?? "lt", buyValue: buy.value ?? 0,
        sellOp: sell.op ?? "lt", sellValue: sell.value ?? 0,
      };
    }
    return out;
  });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const num = (k: string, d = 0) => Number(fd.get(k) ?? d);

    const indicators = kind === "SIGNAL"
      ? Object.entries(inds).map(([name, s]) => ({
        name,
        enabled: s.enabled,
        weight: INDICATOR_MAP.get(name)?.scoring === false ? 0 : s.weight,
        parameters: s.params,
        buyCondition: s.buyOp.startsWith("cross")
          ? { op: s.buyOp, target: INDICATOR_MAP.get(name)?.defaultBuyCondition?.target ?? "secondary" }
          : { op: s.buyOp, value: s.buyValue },
        sellCondition: s.sellOp.startsWith("cross")
          ? { op: s.sellOp, target: INDICATOR_MAP.get(name)?.defaultSellCondition?.target ?? "secondary" }
          : { op: s.sellOp, value: s.sellValue },
      }))
      : [];

    // weight validation — scoring indicators must sum to 100% (signal strategies only)
    if (kind === "SIGNAL") {
      const wSum = indicators.filter((i) => i.enabled && INDICATOR_MAP.get(i.name)?.scoring !== false)
        .reduce((a, i) => a + i.weight, 0);
      if (Math.abs(wSum - 1) > 0.01) {
        setLoading(false);
        toast.error(`مجموع وزن اندیکاتورهای سیگنال‌دهنده باید ۱۰۰٪ باشد (فعلی: ${Math.round(wSum * 100)}٪)`);
        return;
      }
    }

    const payload = {
      name: String(fd.get("name")),
      description: String(fd.get("description") ?? ""),
      kind,
      symbol: String(fd.get("symbol")),
      timeframe: String(fd.get("timeframe")),
      buyThreshold: num("buyThreshold", kind === "ORDER_BOOK_IMBALANCE" ? 0.2 : 0.35),
      sellThreshold: num("sellThreshold", kind === "ORDER_BOOK_IMBALANCE" ? -0.2 : -0.35),
      riskPerTradePct: num("riskPerTradePct", 1),
      stopLossPct: num("stopLossPct", 1),
      takeProfitPct: num("takeProfitPct", 2),
      trailingStop: fd.get("trailingStop") === "on",
      trailingStopPct: num("trailingStopPct", 0) || null,
      maxPositionPct: num("maxPositionPct", 100),
      orderType: kind === "MARKET_MAKING" ? "LIMIT" : String(fd.get("orderType") ?? "MARKET"),
      market: kind === "MARKET_MAKING" ? "SPOT" : market,
      ...(kind !== "MARKET_MAKING" && market === "FUTURES" ? { leverage: num("leverage", 3) } : {}),
      indicators,
      ...(kind === "ORDER_BOOK_IMBALANCE" && {
        orderBookImbalance: {
          depthLevels: num("depthLevels", 10),
          emaPeriod: num("emaPeriod", 1),
        },
      }),
      ...(kind === "MARKET_MAKING" && {
        marketMaking: {
          spreadPct: num("spreadPct", 0.6),
          orderSizePct: num("orderSizePct", 10),
          levels: num("levels", 1),
          levelStepPct: num("levelStepPct", 0.6),
          requotePct: num("requotePct", 0.1),
          maxInventoryPct: num("maxInventoryPct", 60),
        },
      }),
      ...(kind === "ATM_SME" && {
        atmSme: {
          volWindow: num("volWindow", 20),
          gamma: num("gamma", 1.5),
          tokenMid: num("tokenMid", 0.2),
          tokenExtreme: num("tokenExtreme", 0.6),
          emaPeriod: num("emaPeriod", 9),
          useEmaConfirm: fd.get("useEmaConfirm") === "on",
          recoverVt: num("recoverVt", -0.15),
          weakenVt: num("weakenVt", 0.15),
          minPatternWinRate: num("minPatternWinRate", 0.65),
          minPatternCount: num("minPatternCount", 3),
          probWindow: num("probWindow", 300),
          exitTrigger: num("exitTrigger", 0.7),
          exitBack: num("exitBack", 0.4),
          decayLookback: num("decayLookback", 10),
        },
      }),
      ...(kind === "RMM_BSE" && {
        rmmBse: {
          channelLen: num("channelLen", 20),
          squeezeAbs: num("squeezeAbs", 0.35),
          squeezeBars: num("squeezeBars", 5),
          breakoutMt: num("breakoutMt", 0.85),
          exitMt: num("exitMt", 0.1),
          useVolumeConfirm: fd.get("useVolumeConfirm") === "on",
          volMult: num("volMult", 1.5),
          volPeriod: num("volPeriod", 20),
        },
      }),
      ...(kind === "DZS_HMM" && {
        dzsHmm: {
          zWindow: num("zWindow", 60),
          feature: String(fd.get("dzsFeature") ?? "return") === "deviation" ? "deviation" : "return",
          emitCenter: num("emitCenter", 0.6),
          emitSigma: num("emitSigma", 0.35),
          pStay: num("pStay", 0.9),
          bullProb: num("bullProb", 0.75),
          sCross: num("sCross", 0.33),
          persist: num("persist", 1),
          rangeProbExit: num("rangeProbExit", 0.6),
          bearProbExit: num("bearProbExit", 0.6),
        },
      }),
    };

    try {
      const res = await fetch(endpoint, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(json.error ?? "خطایی رخ داد");
      else {
        toast.success("استراتژی ذخیره شد.");
        router.push("/strategies");
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }

  const set = (name: string, patch: Partial<IndicatorState>) =>
    setInds((s) => ({ ...s, [name]: { ...s[name], ...patch } }));
  const setParam = (name: string, key: string, v: number) =>
    setInds((s) => ({ ...s, [name]: { ...s[name], params: { ...s[name].params, [key]: v } } }));

  const totalWeight = Object.entries(inds)
    .filter(([k, i]) => i.enabled && INDICATOR_MAP.get(k)?.scoring !== false)
    .reduce((a, [, i]) => a + i.weight, 0);

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="نام استراتژی">
          <Input name="name" required defaultValue={initial?.name} />
        </Field>
        <Field label="نوع استراتژی">
          <Select value={kind} onChange={(e) => setKind(e.target.value as StrategyKind)}
            options={STRATEGY_KINDS.map((k) => ({ value: k, label: STRATEGY_KIND_LABELS[k] }))} />
        </Field>
        <Field label="نماد (جفت‌ارز)">
          <Select name="symbol" defaultValue={initial?.symbol ?? "BTCIRT"}
            options={pairs.length ? pairs.map((p) => ({ value: p.symbol, label: p.symbol })) : [{ value: "BTCIRT", label: "BTCIRT" }]} />
        </Field>
        <Field label="توضیحات">
          <Input name="description" defaultValue={initial?.description ?? ""} />
        </Field>
        <Field label="تایم‌فریم" hint={kind === "SIGNAL" || SYMBOLIC.has(kind) ? undefined : "برای بک‌تست شبیه‌سازی‌شده و کندل‌های چارت استفاده می‌شود"}>
          <Select name="timeframe" defaultValue={initial?.timeframe ?? (kind === "SIGNAL" ? "15m" : "1m")}
            options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
        </Field>
      </div>

      {SUGGESTABLE.has(kind) && (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <h3 className="font-bold">پیشنهاد خودکار پارامترها</h3>
              <p className="mt-1 text-xs text-muted">
                کندل‌های اخیر {`«نماد/تایم‌فریم انتخابی»`} تحلیل می‌شود و مقادیر بهینه بر اساس نوسان، روند و حجم بازار پر می‌شود.
              </p>
            </div>
            <div className="ms-auto flex flex-wrap items-end gap-2">
              <Field label="میزان ریسک">
                <Select value={risk} onChange={(e) => setRisk(e.target.value as typeof risk)} options={RISK_OPTIONS} />
              </Field>
              <button
                type="button"
                onClick={suggest}
                disabled={suggesting}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {suggesting ? "در حال تحلیل بازار…" : "پیشنهاد بر اساس بازار"}
              </button>
            </div>
          </div>
          {suggestNotes.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-primary/20 pt-3 text-xs leading-5 text-muted">
              {suggestNotes.map((nt, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  {nt}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {kind === "SIGNAL" && (
      <div className="rounded-2xl border border-border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold">اندیکاتورها و وزن‌ها</h3>
          <span className={`text-sm font-bold ${Math.abs(totalWeight - 1) < 0.01 ? "text-success" : "text-warning"}`}>
            مجموع وزن‌ها: {(totalWeight * 100).toFixed(0)}٪
          </span>
        </div>
        <div className="space-y-4">
          {Object.entries(inds).map(([name, s]) => {
            const def = INDICATOR_MAP.get(name);
            const isRisk = def?.role === "risk";
            return (
            <div key={name} className={`rounded-xl border p-4 ${s.enabled ? "border-primary/40" : "border-border opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 font-bold">
                  <input type="checkbox" checked={s.enabled} onChange={(e) => set(name, { enabled: e.target.checked })} className="size-4 accent-primary" />
                  {IND_LABELS[name]}
                </label>
                {isRisk ? (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">فقط برای حد ضرر/سود پویا</span>
                ) : (
                  <label className="flex items-center gap-2 text-sm">
                    وزن:
                    <input type="number" step="any" min={0} max={1} value={s.weight}
                      onChange={(e) => set(name, { weight: Number(e.target.value) })}
                      className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-sm" disabled={!s.enabled} />
                  </label>
                )}
                {Object.keys(s.params).map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-muted">
                    {PARAM_LABELS[k] ?? k}:
                    <input type="number" step="any" value={s.params[k]}
                      onChange={(e) => setParam(name, k, Number(e.target.value))}
                      className="w-20 rounded-lg border border-border bg-card px-2 py-1 text-sm" disabled={!s.enabled} />
                  </label>
                ))}
              </div>
              {def?.description && <p className="mt-1 text-xs text-muted">{def.description}</p>}
              {s.enabled && !isRisk && (
                <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <span className="text-success font-medium">خرید:</span>
                    <select value={s.buyOp} onChange={(e) => set(name, { buyOp: e.target.value })}
                      className="rounded-lg border border-border bg-card px-2 py-1">
                      {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {!s.buyOp.startsWith("cross") && (
                      <input type="number" step="any" value={s.buyValue} onChange={(e) => set(name, { buyValue: Number(e.target.value) })}
                        className="w-24 rounded-lg border border-border bg-card px-2 py-1" />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-danger font-medium">فروش:</span>
                    <select value={s.sellOp} onChange={(e) => set(name, { sellOp: e.target.value })}
                      className="rounded-lg border border-border bg-card px-2 py-1">
                      {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {!s.sellOp.startsWith("cross") && (
                      <input type="number" step="any" value={s.sellValue} onChange={(e) => set(name, { sellValue: Number(e.target.value) })}
                        className="w-24 rounded-lg border border-border bg-card px-2 py-1" />
                    )}
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
      </div>
      )}

      {kind === "ORDER_BOOK_IMBALANCE" && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">تنظیمات عدم تعادل دفتر سفارش (OBI)</h3>
          <p className="mb-3 text-xs text-muted">
            در هر چرخه، حجم خرید و فروش در سطوح برتر دفتر سفارش مقایسه می‌شود. امتیاز بین −۱ تا +۱ است؛
            مقدار مثبت یعنی فشار خرید.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="عمق دفتر (سطوح)" hint="تعداد سطوح برتر که حجمشان جمع می‌شود"
              help="تعداد سطوح برتر دفتر سفارش که حجم bid/ask آن‌ها در محاسبه‌ی عدم‌توازن جمع می‌شود. مقدار کمتر = تمرکز روی لایه‌ی نزدیک قیمت و سیگنال تندتر؛ مقدار بیشتر = تصویر عمیق‌تر بازار و سیگنال نرم‌تر. پیش‌فرض ۱۰.">
              <Input name="depthLevels" type="number" min={1} max={50} defaultValue={10} required />
            </Field>
            <Field label="هموارسازی EMA (تیک)" hint="۱ یعنی بدون هموارسازی"
              help="میانگین متحرک نمایی روی امتیاز OBI در تیک‌های متوالی. ۱ یعنی مقدار خام — واکنش سریع ولی نویزی. اعداد بزرگ‌تر نویز لحظه‌ای را صاف می‌کنند ولی ورود/خروج را با تأخیر می‌اندازند.">
              <Input name="emaPeriod" type="number" min={1} max={200} defaultValue={1} required />
            </Field>
          </div>
        </div>
      )}

      {kind === "MARKET_MAKING" && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">تنظیمات مارکت میکر</h3>
          <p className="mb-3 text-xs text-muted">
            در هر چرخه، سفارش‌های خرید و فروش محدود (Limit) حول قیمت میانی قرار می‌گیرند و با جابه‌جایی قیمت بازنشانی می‌شوند.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="اسپرد کل ٪" hint="فاصله‌ی بین قیمت خرید و فروش حول میانی"
              help="فاصله‌ی کل بین کوت خرید و فروش حول قیمت میانی — یعنی سود هر چرخه‌ی کامل خرید/فروش. بزرگ‌تر = حاشیه‌ی بیشتر هر معامله ولی احتمال فیل کمتر؛ کوچک‌تر = فیل‌های مکرر با سود باریک. در بازار پرنوسان معمولاً بزرگ‌تر می‌گذارند تا هزینه‌ی نوسان پوشش داده شود.">
              <Input name="spreadPct" type="number" step="any" min={0.01} max={10} defaultValue={0.6} required />
            </Field>
            <Field label="حجم هر سفارش ٪" hint="درصد سرمایه‌ی اختصاصی برای هر کوت"
              help="درصدی از سرمایه‌ی در گردش استراتژی که روی هر کوت گذاشته می‌شود. بزرگ‌تر = سود بیشتر هر فیل ولی ریسک موجودی بالاتر؛ اگر چند سطح تعریف کنید، مجموع سطوح تقریباً levels × این مقدار می‌شود.">
              <Input name="orderSizePct" type="number" step="1" min={0.1} max={100} defaultValue={10} required />
            </Field>
            <Field label="تعداد سطوح هر سمت"
              help="تعداد کوت‌ها در هر سمت (خرید و فروش). چند سطح = پوشش قیمتی پهن‌تر و فیل تدریجی هنگام حرکت قیمت؛ یک سطح = ساده‌تر ولی سفارش‌های درشت‌تر در یک نقطه.">
              <Input name="levels" type="number" min={1} max={10} defaultValue={1} required />
            </Field>
            <Field label="فاصله سطوح ٪" hint="فاصله‌ی اضافی بین سطوح متوالی"
              help="فاصله‌ی بین سطوح متوالی هر سمت به درصد. سطح اول در نصف اسپرد از میانی قرار می‌گیرد و هر سطح بعدی به همین مقدار دورتر می‌رود.">
              <Input name="levelStepPct" type="number" step="any" min={0} max={10} defaultValue={0.6} required />
            </Field>
            <Field label="آستانه بازنشانی ٪" hint="حداقل جابه‌جایی قیمت برای لغو و ثبت مجدد"
              help="اگر قیمت میانی بیش از این درصد جابه‌جا شود، کوت‌های فعلی لغو و حول قیمت جدید بازنشانی می‌شوند. کوچک‌تر = تعقیب سریع قیمت (نرخ لغو/ثبت بالاتر)؛ بزرگ‌تر = کوت‌های ماندگارتر با ریسک فیل در قیمت قدیمی.">
              <Input name="requotePct" type="number" step="any" min={0} max={10} defaultValue={0.1} required />
            </Field>
            <Field label="حداکثر موجودی ٪" hint="بالای این سطح، کوت خرید ثبت نمی‌شود"
              help="سقف درصد دارایی پایه در کل پرتفوی استراتژی. وقتی موجودی از این حد بگذرد، کوت خرید جدید ثبت نمی‌شود تا انباشت دارایی در روند نزولی کنترل شود — مهم‌ترین محافظ ریسک مارکت‌میکینگ.">
              <Input name="maxInventoryPct" type="number" step="1" min={1} max={100} defaultValue={60} required />
            </Field>
          </div>
        </div>
      )}

      {kind === "ATM_SME" && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">تنظیمات موتور سمبلیک مومنتوم (ATM-SME)</h3>
          <p className="mb-3 text-xs text-muted">
            بازده لگاریتمی هر کندل با نوسان متحرک نرمال و با tanh فشرده می‌شود (Vt ∈ [−۱,+۱]) و به توکن‌های
            A تا E نگاشت می‌شود. خرید با الگوهای خستگی فروش مانند E,E,C / E,E,D + بازیابی Vt + تأیید EMA و
            آستانه‌ی احتمال تاریخی الگو انجام می‌شود؛ خروج با الگوی فروش یا افت مومنتوم (اوج → بازگشت).
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="پنجره نوسان σt" hint="تعداد بازده‌های گذشته برای انحراف معیار"
              help="پنجره‌ی محاسبه‌ی انحراف معیار بازده‌های لگاریتمی — مرجع نرمال‌سازی Vt. کوچک‌تر = نوسان‌سنجی محلی و حساسیت بیشتر به تغییرات اخیر؛ بزرگ‌تر = مرجع پایدارتر و توکن‌های شدید دیرتر.">
              <Input name="volWindow" type="number" min={2} max={500} defaultValue={20} required />
            </Field>
            <Field label="ضریب حساسیت γ" hint="بزرگ‌تر = Vt ملایم‌تر"
              help="ضریب مقیاس داخل tanh: Vt = tanh(rt / (γ·σt)). بزرگ‌تر = Vt فشرده‌تر به صفر → نواحی شدید A/E دیرتر تشکیل می‌شوند (سیگنال کمتر ولی قوی‌تر)؛ کوچک‌تر = اشباع سریع Vt و حساسیت بالا.">
              <Input name="gamma" type="number" step="any" min={0.01} max={100} defaultValue={1.5} required />
            </Field>
            <Field label="دوره EMA تأیید"
              help="دوره‌ی میانگین متحرک نمایی برای فیلتر روند. اگر «تأیید بسته‌شدن روی EMA» فعال باشد، خرید فقط بالای EMA و الگوی فروش فقط زیر EMA معتبر است. دوره‌ی کوتاه‌تر = تایید سریع‌تر ولی پرنویزتر.">
              <Input name="emaPeriod" type="number" min={1} max={200} defaultValue={9} required />
            </Field>
            <Field label="مرز میانی توکن ±" hint="پیش‌فرض ۰٫۲۰ → نواحی B/D"
              help="مرز ناحیه‌ی خنثی: |Vt| کمتر از این مقدار = توکن C (خنثی). بزرگ‌تر = ناحیه‌ی C پهن‌تر و توکن‌های B/D باریک‌تر؛ کوچک‌تر = حساسیت بیشتر به حرکات کوچک. مرز توکن‌ها: A ≥ شدید، B ≥ میانی، C خنثی، D ≤ −میانی، E ≤ −شدید.">
              <Input name="tokenMid" type="number" step="any" min={0.01} max={0.99} defaultValue={0.2} required />
            </Field>
            <Field label="مرز شدید توکن ±" hint="پیش‌فرض ۰٫۶۰ → نواحی A/E"
              help="مرز نواحی شدید: |Vt| بالای این مقدار = توکن A (صعودی شدید) یا E (نزولی شدید). الگوهای ورود نیازمند توکن‌های E متوالی‌اند؛ کوچک‌تر کردن = رسیدن زودتر به توکن شدید و کامل‌شدن سریع‌تر الگوها.">
              <Input name="tokenExtreme" type="number" step="any" min={0.01} max={1} defaultValue={0.6} required />
            </Field>
            <Field label="بازیابی Vt برای خرید" hint="Vt باید از ناحیه منفی به بالای این مقدار برسد"
              help="شرط بازیابی مومنتوم بعد از الگوی خستگی فروش (E,E,C یا E,E,D): Vt کندل سوم باید بالای این مقدار باشد. منفی‌تر = ورود زودتر و تهاجمی‌تر؛ نزدیک صفر یا مثبت = تایید بازگشت قوی‌تر ولی ورود دیرتر.">
              <Input name="recoverVt" type="number" step="any" min={-1} max={1} defaultValue={-0.15} required />
            </Field>
            <Field label="تضعیف Vt برای فروش" hint="الگوی فروش + Vt زیر این مقدار = خروج"
              help="شرط تضعیف برای الگوی خروج (A,A,C یا A,A,B): اگر الگوی فروش دیده شود ولی Vt هنوز بالای این مقدار باشد، خروج صادر نمی‌شود — یعنی مومنتوم هنوز قوی است. کوچک‌تر = تحمل بیشتر و خروج دیرتر.">
              <Input name="weakenVt" type="number" step="any" min={-1} max={1} defaultValue={0.15} required />
            </Field>
            <Field label="حداقل احتمال تاریخی الگو" hint="۰–۱ — ۰ یعنی بدون گیت احتمال"
              help="گیت تاریخچه: الگوی ورود فقط وقتی معتبر است که در گذشته‌ی همین نمودار، دست‌کم به این نرخ برد رسیده باشد (یعنی بعد از آن کندل صعودی آمده). ۰ = غیرفعال؛ ۰٫۶۵ پیش‌فرض سند — ورود فقط به الگوهایی که تاریخاً کار کرده‌اند.">
              <Input name="minPatternWinRate" type="number" step="any" min={0} max={1} defaultValue={0.65} required />
            </Field>
            <Field label="حداقل تکرار الگو" hint="تعداد وقوع تاریخی لازم برای گیت احتمال"
              help="حداقل دفعات وقوع الگو در پنجره‌ی آمار تا نمونه‌ی آماری معتبر شود. اگر الگو کمتر از این تعداد دیده شده باشد، ورود رد می‌شود — جلوی تصمیم بر اساس چند نمونه‌ی شانسی را می‌گیرد.">
              <Input name="minPatternCount" type="number" min={0} max={100} defaultValue={3} required />
            </Field>
            <Field label="پنجره آمار الگو" hint="تعداد کندل‌های گذشته برای محاسبه احتمال"
              help="تعداد کندل‌های گذشته که نرخ برد الگو روی آن‌ها برآورد می‌شود. بزرگ‌تر = آمار پایدارتر ولی واکنش کندتر به تغییر رژیم بازار؛ کوچک‌تر = تطبیق سریع‌تر با رفتار اخیر نمودار.">
              <Input name="probWindow" type="number" min={10} max={5000} defaultValue={300} required />
            </Field>
            <Field label="ماشه افت: اوج Vt" hint="اگر Vt به این سطح برسد و برگردد، خروج"
              help="خروج افت مومنتوم (قفل سود روی افت شتاب): اگر در «پنجره اوج» اخیر Vt به بالای این سطح رسیده باشد و حالا زیر «بازگشت Vt» آمده، موقعیت بسته می‌شود. بالاتر = فقط بعد از اوج‌های قوی خروج می‌کند.">
              <Input name="exitTrigger" type="number" step="any" min={-1} max={1} defaultValue={0.7} required />
            </Field>
            <Field label="ماشه افت: بازگشت Vt"
              help="سطح بازگشت برای خروج افت مومنتوم: بعد از رسیدن Vt به اوج، افت زیر این مقدار یعنی شتاب مرده است. بالاتر = خروج سریع‌تر روی اولین ضعف؛ پایین‌تر = فضای تنفس بیشتر برای موقعیت.">
              <Input name="exitBack" type="number" step="any" min={-1} max={1} defaultValue={0.4} required />
            </Field>
            <Field label="پنجره اوج (کندل)"
              help="تعداد کندل‌های اخیر که برای یافتن اوج Vt بررسی می‌شود — تقریب بی‌حالتی «اوج از زمان ورود». کوچک‌تر = خروج حساس‌تر روی ریزش‌های اخیر؛ بزرگ‌تر = اوج‌های قدیمی‌تر هم در نظر گرفته می‌شوند.">
              <Input name="decayLookback" type="number" min={1} max={200} defaultValue={10} required />
            </Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" name="useEmaConfirm" defaultChecked className="size-4 accent-primary" />
              تأیید بسته‌شدن روی EMA
              <HelpTip text="فیلتر روند: وقتی فعال است، سیگنال خرید فقط اگر قیمت بالای EMA بسته شود معتبر است و الگوی فروش فقط زیر EMA. غیرفعال = ورود صرفاً بر اساس الگوی توکن — سیگنال بیشتر ولی در روند مخالف هم ورود می‌کند." />
            </label>
          </div>
        </div>
      )}

      {kind === "RMM_BSE" && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">تنظیمات موتور شکست کانال (RMM-BSE)</h3>
          <p className="mb-3 text-xs text-muted">
            موقعیت بسته‌شدن نسبت به کانال k کندل قبلی نگاشت می‌شود (Mt ∈ [−۱,+۱]). خرید وقتی دست‌کم چند کندل
            رنج متوالی دیده شود و کندل در ناحیه شکست بسته شود (با تأیید حجم اختیاری)؛ خروج وقتی Mt زیر آستانه
            برگردد.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="طول کانال k" hint="کندل‌های قبل از سیگنال — بدون نشت آینده"
              help="کانال Donchian روی k کندل *قبلی* ساخته می‌شود (کندل جاری داخل آن نیست تا نشت آینده پیش نیاید). کوتاه‌تر = شکست‌های زودتر و سیگنال بیشتر؛ بلندتر = کانال ساختاری‌تر و شکست‌های معتبرتر ولی کمتر.">
              <Input name="channelLen" type="number" min={2} max={500} defaultValue={20} required />
            </Field>
            <Field label="باند رنج |M|" hint="|M| ≤ این مقدار = فشردگی"
              help="آستانه‌ی تشخیص فشردگی: Mt موقعیت close داخل کانال است (−۱ کف تا +۱ سقف). |Mt| کمتر از این مقدار یعنی قیمت وسط کانال گیر کرده = رنج. بزرگ‌تر = شرط رنج آسوده‌تر → فرصت‌های ورود بیشتر؛ کوچک‌تر = فقط فشردگی‌های واقعی.">
              <Input name="squeezeAbs" type="number" step="any" min={0.01} max={1} defaultValue={0.35} required />
            </Field>
            <Field label="کندل‌های رنج لازم" hint="تعداد متوالی قبل از شکست"
              help="حداقل تعداد کندل‌های متوالی فشرده که باید قبل از شکست دیده شود تا ورود معتبر باشد. بیشتر = انباشت انرژی بیشتر قبل از حرکت → شکست‌های باکیفیت‌تر ولی نادرتر.">
              <Input name="squeezeBars" type="number" min={1} max={100} defaultValue={5} required />
            </Field>
            <Field label="ناحیه شکست |M|" hint="ورود وقتی M ≥ این مقدار"
              help="آستانه‌ی شکست صعودی: ورود وقتی Mt به این سطح یا بالاتر برسد — یعنی close نزدیک یا بالای سقف کانال قبلی بسته شده. نزدیک ۱ = فقط شکست‌های قاطع سقف؛ پایین‌تر = ورود زودتر با احتمال شکست کاذب بیشتر.">
              <Input name="breakoutMt" type="number" step="any" min={0.01} max={1} defaultValue={0.85} required />
            </Field>
            <Field label="آستانه خروج M" hint="خروج وقتی M زیر این مقدار برگردد"
              help="خروج وقتی Mt زیر این مقدار برگردد — یعنی قیمت به داخل کانال برگشته و شکست شکست خورده. نزدیک صفر = خروج روی برگشت به میانه؛ منفی‌تر = تحمل اصلاح عمیق‌تر قبل از خروج.">
              <Input name="exitMt" type="number" step="any" min={-1} max={1} defaultValue={0.1} required />
            </Field>
            <Field label="دوره میانگین حجم"
              help="پنجره‌ی میانگین حجم برای مقایسه با حجم کندل شکست. مرجع «حجم عادی» بازار است — دوره‌ی کوتاه‌تر با بازار اخیر تطبیق می‌کند، بلندتر مبنای پایدارتری می‌دهد.">
              <Input name="volPeriod" type="number" min={1} max={500} defaultValue={20} required />
            </Field>
            <Field label="ضریب حجم تأیید" hint="حجم کندل شکست ≥ ضریب × میانگین"
              help="تایید حجم در ورود: حجم کندل شکست باید حداقل این ضریب برابر میانگین حجم باشد — یعنی شکست با مشارکت واقعی بازار. بزرگ‌تر = فیلتر سخت‌گیرانه‌تر و سیگنال کمتر ولی معتبرتر؛ فقط وقتی اعمال می‌شود که «تأیید حجم» فعال باشد.">
              <Input name="volMult" type="number" step="any" min={0.1} max={100} defaultValue={1.5} required />
            </Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" name="useVolumeConfirm" defaultChecked className="size-4 accent-primary" />
              تأیید حجم در ورود
              <HelpTip text="وقتی فعال است، ورود فقط اگر کندل شکست حجم بالاتر از «ضریب حجم × میانگین» داشته باشد انجام می‌شود — شکست‌های بدون حجم (اغلب کاذب) رد می‌شوند. غیرفعال = ورود صرفاً بر اساس قیمت." />
            </label>
          </div>
        </div>
      )}

      {kind === "DZS_HMM" && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">تنظیمات موتور رژیم بازار (DZS-HMM)</h3>
          <p className="mb-3 text-xs text-muted">
            مشاهده به‌صورت Z-Score نرمال می‌شود (St = clip(Z/3)) و فیلتر پیش‌روی مارکوف، احتمال سه حالت
            رنج/صعودی/نزولی را تخمین می‌زند. خرید: P(صعودی) ≥ آستانه + عبور St به بالای سطح. خروج: برتری
            احتمال رنج یا نزولی.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="پنجره Z-Score" hint="پنجره متحرک میانگین/انحراف"
              help="پنجره‌ی متحرک میانگین و انحراف معیار مشاهده برای محاسبه‌ی Z-Score. کوتاه‌تر = واکنش سریع به تغییر رژیم ولی مبنای ناپایدار؛ بلندتر = مبنای پایدارتر و تشخیص رژیم کندتر.">
              <Input name="zWindow" type="number" min={5} max={1000} defaultValue={60} required />
            </Field>
            <Field label="ویژگی مشاهده" hint="بازده لگاریتمی ایستاناتر است"
              help="ورودی Z-Score: «بازده لگاریتمی» تغییرات نسبی قیمت را می‌سنجد (ایستاناتر و پیشنهاد سند)؛ «انحراف از میانگین» فاصله‌ی قیمت از میانگین متحرک پنجره را می‌سنجد — در بازارهای mean-reverting مناسب‌تر است.">
              <Select name="dzsFeature" defaultValue="return"
                options={[{ value: "return", label: "بازده لگاریتمی" }, { value: "deviation", label: "انحراف از میانگین" }]} />
            </Field>
            <Field label="مرکز انتشار روند" hint="مرکز St برای حالت‌های صعودی/نزولی"
              help="مرکز توزیع انتشار حالت‌های روند: حالت صعودی روی +این مقدار و نزولی روی −این مقدار متمرکز است. بزرگ‌تر = رژیم روند فقط با St قوی‌تر تشخیص داده می‌شود (کمتر فریب نویز را می‌خورد).">
              <Input name="emitCenter" type="number" step="any" min={0.05} max={1} defaultValue={0.6} required />
            </Field>
            <Field label="سیگمای انتشار" hint="پهنای تابع احتمال انتشار"
              help="پهنای تابع انتشار گاوسی. کوچک‌تر = تفکیک تیز رژیم‌ها (فقط مشاهده‌های خیلی نزدیک به مرکز هر حالت به آن نسبت داده می‌شوند)؛ بزرگ‌تر = احتمالات نرم‌تر و مرز رژیم‌ها محوتر.">
              <Input name="emitSigma" type="number" step="any" min={0.01} max={2} defaultValue={0.35} required />
            </Field>
            <Field label="پایداری رژیم P(ماندن)" hint="قطر ماتریس انتقال — بزرگ‌تر = رژیم چسبنده‌تر"
              help="احتمال ماندن در رژیم فعلی در هر کندل (قطر ماتریس انتقال). نزدیک ۱ = رژیم‌ها چسبنده و تغییر آن‌ها سخت — نویز کمتر ولی واکنش دیرتر به چرخش واقعی بازار؛ پایین‌تر = تعویض سریع رژیم.">
              <Input name="pStay" type="number" step="any" min={0.5} max={0.99} defaultValue={0.9} required />
            </Field>
            <Field label="آستانه P(صعودی) خرید" hint="۰–۱"
              help="شرط اصلی ورود: احتمال فیلترشده‌ی رژیم صعودی باید به این آستانه برسد. بالاتر = ورودهای کمتر ولی مطمئن‌تر؛ پایین‌تر = ورود تهاجمی‌تر. همراه «سطح عبور St» و «پایداری شرط» اعمال می‌شود.">
              <Input name="bullProb" type="number" step="any" min={0.5} max={0.99} defaultValue={0.75} required />
            </Field>
            <Field label="سطح عبور St" hint="عبور صعودی از این سطح لازم است"
              help="تأیید جهت: علاوه بر احتمال رژیم، خودِ St (Z-Score نرمال‌شده) باید بالای این سطح باشد تا ورود شود — جلوی ورود روی احتمال بالا در بازار ضعیف را می‌گیرد.">
              <Input name="sCross" type="number" step="any" min={0.01} max={1} defaultValue={0.33} required />
            </Field>
            <Field label="پایداری شرط (کندل)" hint="چند کندل متوالی احتمال بالا بماند"
              help="شرط احتمال باید این تعداد کندل متوالی برقرار بماند تا ورود صادر شود — فیلتر جهش‌های لحظه‌ای احتمال. ۱ = بدون فیلتر؛ ۲–۳ معمولاً نویز تک‌کندله را می‌گیرد با تأخیر کوچک.">
              <Input name="persist" type="number" min={1} max={20} defaultValue={1} required />
            </Field>
            <Field label="آستانه خروج P(رنج)" hint="۰–۱"
              help="خروج وقتی احتمال رژیم رنج (خنثی) به این آستانه برسد — یعنی روند صعودی تمام شده و بازار وارد سایدوی شده. بالاتر = تحمل بیشتر و خروج دیرتر؛ پایین‌تر = خروج محافظه‌کارانه‌تر.">
              <Input name="rangeProbExit" type="number" step="any" min={0.1} max={0.99} defaultValue={0.6} required />
            </Field>
            <Field label="آستانه خروج P(نزولی)" hint="۰–۱"
              help="خروج وقتی احتمال رژیم نزولی به این آستانه برسد — یعنی روند برعکس شده. پایین‌تر = خروج حساس‌تر به چرخش بازار؛ بالاتر = فقط با اطمینان بالای نزولی خارج می‌شود.">
              <Input name="bearProbExit" type="number" step="any" min={0.1} max={0.99} defaultValue={0.6} required />
            </Field>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {showThresholds(kind) && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">آستانه سیگنال (امتیاز −۱ تا +۱)</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="آستانه خرید"
              help="امتیاز سیگنال باید به این سطح یا بالاتر برسد تا ورود انجام شود. برای OBI امتیاز همان عدم‌توازن دفتر سفارش است (−۱ تا +۱). بالاتر = ورودهای کمتر ولی مطمئن‌تر؛ پایین‌تر = حساسیت بیشتر به فشار خرید.">
              <Input name="buyThreshold" type="number" step="any" defaultValue={initial?.buyThreshold ?? (kind === "ORDER_BOOK_IMBALANCE" ? 0.2 : 0.35)} required />
            </Field>
            <Field label="آستانه فروش"
              help="وقتی امتیاز به این سطح یا پایین‌تر برسد، خروج صادر می‌شود (مقدار منفی یعنی فشار فروش). منفیِ بزرگ‌تر = خروج فقط روی فشار فروش قوی؛ نزدیک صفر = خروج زودتر روی ضعف امتیاز.">
              <Input name="sellThreshold" type="number" step="any" defaultValue={initial?.sellThreshold ?? (kind === "ORDER_BOOK_IMBALANCE" ? -0.2 : -0.35)} required />
            </Field>
          </div>
        </div>
        )}
        {kind !== "MARKET_MAKING" && (
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 font-bold">مدیریت ریسک</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ریسک هر معامله ٪"><Input name="riskPerTradePct" type="number" step="any" defaultValue={initial?.riskPerTradePct ?? 1} required /></Field>
            <Field label="حداکثر موقعیت ٪"><Input name="maxPositionPct" type="number" step="1" defaultValue={initial?.maxPositionPct ?? 100} required /></Field>
            <Field label="حد ضرر ٪"><Input name="stopLossPct" type="number" step="any" defaultValue={initial?.stopLossPct ?? 1} required /></Field>
            <Field label="حد سود ٪"><Input name="takeProfitPct" type="number" step="any" defaultValue={initial?.takeProfitPct ?? 2} required /></Field>
            <Field label="نوع سفارش">
              <Select name="orderType" defaultValue={initial?.orderType ?? "MARKET"}
                options={[{ value: "MARKET", label: "بازار (Market)" }, { value: "LIMIT", label: "محدود (Limit)" }]} />
            </Field>
            <Field label="بازار"
              help="اسپات: فقط خرید (لانگ) با موجودی واقعی. فیوچرز: معاملات تعهدی نوبیتکس — امکان شورت (سود از ریزش) و ضریب اهرمی. در فیوچرز رسیدن قیمت به سطح لیکوییدیشن کل مارجین را می‌سوزاند.">
              <Select value={market} onChange={(e) => setMarket(e.target.value as "SPOT" | "FUTURES")}
                options={[{ value: "SPOT", label: "اسپات" }, { value: "FUTURES", label: "فیوچرز (تعهدی)" }]} />
            </Field>
            {market === "FUTURES" && (
            <Field label="لورج (اهرم)"
              help="ضریب اهرمی پوزیشن — مثلاً ۳× یعنی با هر ۱ تومان مارجین، ۳ تومان موقعیت. سود و زیان به نسبت اهرم بزرگ‌تر می‌شود و فاصله‌ی لیکوییدیشن ≈ ۱۰۰÷اهرم درصد است (۳× ⇒ ~۳۰٪). حداکثر ۱۰، گام‌های ۰٫۵.">
              <Input name="leverage" type="number" step="any" min={1} max={10} defaultValue={initial?.leverage ?? 3} required />
            </Field>
            )}
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" name="trailingStop" defaultChecked={initial?.trailingStop} className="size-4 accent-primary" />
              تریلینگ استاپ
            </label>
            <Field label="درصد تریلینگ"><Input name="trailingStopPct" type="number" step="any" defaultValue={initial?.trailingStopPct ?? ""} /></Field>
          </div>
        </div>
        )}
      </div>

      <button type="submit" disabled={loading}
        className="w-full rounded-xl bg-primary px-4 py-3 font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50">
        {loading ? "در حال ذخیره…" : submitLabel}
      </button>
    </form>
  );
}
