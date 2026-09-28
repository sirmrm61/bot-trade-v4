"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardTitle, Badge, EmptyState, Table } from "@/components/ui";
import { cn, faNumber, faPercent } from "@/shared/utils";
import { jalaliDateTime } from "@/shared/jalali";
import type { PairRank, RankResult } from "@/modules/scalping/types";
import { CRITERION_KEYS, CRITERION_LABELS, SCALPING_DEFAULTS } from "@/modules/scalping/config";
import { EXCHANGE_LABELS } from "@/shared/constants";

const MARKET_LABELS: Record<string, string> = { SPOT: "اسپات", PERPETUAL: "پرپچوال" };
const TF_OPTIONS = ["1m", "5m", "15m", "1h"];

interface Filters {
  exchange: string;
  quote: string;
  market: string;
  base: string;
  minVolumeUsd: string;
  orderSizeUsd: string;
  leverage: string;
  costMode: string;
  makerFeePct: string;
  candleTimeframe: string;
  feePct: string;
  showExcluded: boolean;
}

const DEFAULT_FILTERS: Filters = {
  exchange: "all",
  quote: "all",
  market: "all",
  base: "",
  minVolumeUsd: "",
  orderSizeUsd: String(SCALPING_DEFAULTS.orderSizeUsd),
  leverage: String(SCALPING_DEFAULTS.leverage),
  costMode: SCALPING_DEFAULTS.costMode,
  makerFeePct: String(SCALPING_DEFAULTS.makerFeePct),
  candleTimeframe: SCALPING_DEFAULTS.candleTimeframe,
  feePct: String(SCALPING_DEFAULTS.feePctPerSide),
  showExcluded: true,
};

export function ScalpPanel() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(CRITERION_KEYS.map((k) => [k, String(SCALPING_DEFAULTS.weights[k])])),
  );
  const [showSettings, setShowSettings] = useState(false);
  const [data, setData] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (f: Filters, w: Record<string, string>) => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ quote: f.quote, market: f.market });
      if (f.exchange !== "all") p.set("exchange", f.exchange);
      if (f.base.trim()) p.set("base", f.base.trim());
      if (num(f.minVolumeUsd)) p.set("minVolumeUsd", f.minVolumeUsd);
      if (num(f.orderSizeUsd)) p.set("orderSizeUsd", f.orderSizeUsd);
      if (num(f.leverage)) p.set("leverage", f.leverage);
      p.set("costMode", f.costMode);
      if (num(f.makerFeePct)) p.set("makerFeePct", f.makerFeePct);
      if (f.candleTimeframe) p.set("candleTimeframe", f.candleTimeframe);
      if (num(f.feePct)) p.set("feePct", f.feePct);
      for (const k of CRITERION_KEYS) if (num(w[k])) p.set(`w_${k}`, w[k]);
      p.set("includeExcluded", f.showExcluded ? "1" : "0");

      const res = await fetch(`/api/scalping?${p}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "خطا در دریافت داده");
      setData(json as RankResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای ناشناخته");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(filters, weights), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => data?.pairs ?? [], [data]);

  return (
    <div className="space-y-4">
      {/* disclaimer */}
      <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        {data?.meta.disclaimer ??
          "رتبه‌بندی صرفاً بر اساس داده‌های بازار و معیارهای انتخاب‌شده است و سودآوری را تضمین نمی‌کند."}
      </div>

      {/* filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="صرافی">
            <select className={inputCls} value={filters.exchange}
              onChange={(e) => setFilters({ ...filters, exchange: e.target.value })}>
              <option value="all">همه</option>
              <option value="NOBITEX">نوبیتکس</option>
              <option value="KUCOIN">کوکوین</option>
            </select>
          </Field>
          <Field label="مارکت">
            <select className={inputCls} value={filters.quote}
              onChange={(e) => setFilters({ ...filters, quote: e.target.value })}>
              <option value="all">همه</option>
              <option value="IRT">تومان (IRT)</option>
              <option value="USDT">تتر (USDT)</option>
            </select>
          </Field>
          <Field label="نوع بازار">
            <select className={inputCls} value={filters.market}
              onChange={(e) => setFilters({ ...filters, market: e.target.value })}>
              <option value="all">همه</option>
              <option value="SPOT">اسپات</option>
              <option value="PERPETUAL">پرپچوال</option>
            </select>
          </Field>
          <Field label="دارایی پایه">
            <input className={inputCls} placeholder="BTC, ETH…" value={filters.base}
              onChange={(e) => setFilters({ ...filters, base: e.target.value })} />
          </Field>
          <Field label="حداقل حجم ۲۴س ($)">
            <input className={inputCls} inputMode="numeric" value={filters.minVolumeUsd}
              onChange={(e) => setFilters({ ...filters, minVolumeUsd: e.target.value })} />
          </Field>
          <Field label="مارجین فرضی ($)">
            <input className={inputCls} inputMode="numeric" value={filters.orderSizeUsd}
              onChange={(e) => setFilters({ ...filters, orderSizeUsd: e.target.value })} />
          </Field>
          <Field label="اهرم">
            <input className={inputCls} inputMode="decimal" value={filters.leverage}
              onChange={(e) => setFilters({ ...filters, leverage: e.target.value })} />
          </Field>
          <Field label="سبک ورود">
            <select className={inputCls} value={filters.costMode}
              onChange={(e) => setFilters({ ...filters, costMode: e.target.value })}>
              <option value="TAKER">تیکر (مارکت)</option>
              <option value="MAKER">میکر (لیمیت)</option>
              <option value="MIXED">ترکیبی</option>
            </select>
          </Field>
          <Field label="کارمزد میکر (٪)">
            <input className={inputCls} inputMode="decimal" value={filters.makerFeePct}
              onChange={(e) => setFilters({ ...filters, makerFeePct: e.target.value })} />
          </Field>
          <Field label="بازه تحلیل">
            <select className={inputCls} value={filters.candleTimeframe}
              onChange={(e) => setFilters({ ...filters, candleTimeframe: e.target.value })}>
              {TF_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="کارمزد تیکر (٪)">
            <input className={inputCls} inputMode="decimal" value={filters.feePct}
              onChange={(e) => setFilters({ ...filters, feePct: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={filters.showExcluded}
              onChange={(e) => setFilters({ ...filters, showExcluded: e.target.checked })} />
            نمایش حذف‌شده‌ها
          </label>
          <button
            onClick={() => load(filters, weights)}
            disabled={loading}
            className="rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "در حال اسکن…" : "اسکن مجدد"}
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="rounded-xl border border-border px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            تنظیمات امتیازدهی
          </button>
        </div>

        {showSettings && (
          <div className="mt-4 rounded-xl border border-border p-4">
            <CardTitle>وزن معیارها (۰ تا ۱۰۰)</CardTitle>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {CRITERION_KEYS.map((k) => (
                <Field key={k} label={CRITERION_LABELS[k]}>
                  <input className={inputCls} inputMode="numeric" value={weights[k]}
                    onChange={(e) => setWeights({ ...weights, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
            <p className="mt-3 text-xs leading-6 text-muted">
              روش امتیازدهی: هر معیار با نگاشت خطی یا لگاریتمی نسبت به نقاط مرجع به بازه ۰ تا ۱۰۰ تبدیل
              می‌شود (مثلاً اسپرد صفر = ۱۰۰، اسپرد ۱٪ یا بیشتر = ۰). امتیاز کل = میانگین وزنی معیارهایی که
              داده‌ی معتبر و تازه دارند؛ وزن معیارهای فاقد داده بازتوزیع می‌شود و ردیف به‌عنوان «داده ناقص»
              علامت می‌خورد. جفت‌هایی که آستانه‌های حداقلی را نقض کنند (حجم ناچیز، اسپرد یا هزینه بیش از حد)
              حذف می‌شوند. هزینه رفت‌وبرگشت بسته به سبک ورود: تیکر = لغزش خرید + فروش + دو برابر کارمزد تیکر؛
              میکر = دو برابر کارمزد میکر (بدون لغزش، با ریسک پر نشدن)؛ ترکیبی = ورود میکر + خروج تیکر.
              ارزش پوزیشن = مارجین × اهرم و «حداقل حرکت سودآور» همان هزینه رفت‌وبرگشت به درصد قیمت است
              (روی مارجین با ضرب در اهرم محاسبه می‌شود).
            </p>
          </div>
        )}
      </Card>

      {/* meta */}
      {data && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>منبع: {data.meta.source}</span>
          <span>کل جفت‌ها: {faNumber(data.meta.totalPairs)}</span>
          <span>رتبه‌دار: {faNumber(data.meta.ranked)}</span>
          <span>داده ناقص: {faNumber(data.meta.partial)}</span>
          <span>حذف‌شده: {faNumber(data.meta.excluded)}</span>
          <span>بدون داده: {faNumber(data.meta.noData)}</span>
          {data.meta.usdIrtRate && <span>نرخ تتر: {faNumber(data.meta.usdIrtRate / 10)} تومان</span>}
          <span>به‌روزرسانی: {jalaliDateTime(data.meta.generatedAt)}</span>
        </div>
      )}

      {/* states */}
      {error && (
        <EmptyState title="خطا در دریافت داده" hint={error} />
      )}
      {!error && !loading && data && shown.length === 0 && (
        <EmptyState
          title="جفتی برای نمایش نیست"
          hint="فیلترها را بازتر کنید یا نمایش حذف‌شده‌ها را فعال کنید"
        />
      )}
      {!error && loading && !data && (
        <Card><div className="py-10 text-center text-sm text-muted">در حال دریافت داده از صرافی…</div></Card>
      )}

      {/* table */}
      {shown.length > 0 && (
        <Table headers={["#", "جفت", "صرافی", "بازار", "امتیاز", "حجم ۲۴س", "اسپرد", "لغزش", "نوسان", "هزینه رفت‌وبرگشت", "کیفیت داده", ""]}>
          {shown.map((p, i) => (
            <PairRow
              key={`${p.exchange}:${p.symbol}`}
              p={p}
              idx={i}
              expanded={expanded === p.symbol}
              onToggle={() => setExpanded(expanded === p.symbol ? null : p.symbol)}
            />
          ))}
        </Table>
      )}
    </div>
  );
}

function PairRow({ p, idx, expanded, onToggle }: { p: PairRank; idx: number; expanded: boolean; onToggle: () => void }) {
  const m = p.metrics;
  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-3 text-muted">{faNumber(idx + 1)}</td>
        <td className="px-4 py-3 font-bold">
          {p.baseCurrency}
          <span className="text-xs font-normal text-muted">/{p.quoteCurrency}</span>
        </td>
        <td className="px-4 py-3 text-xs text-muted">{EXCHANGE_LABELS[p.exchange as keyof typeof EXCHANGE_LABELS] ?? p.exchange}</td>
        <td className="px-4 py-3"><Badge tone="info">{MARKET_LABELS[p.marketType] ?? p.marketType}</Badge></td>
        <td className="px-4 py-3">
          {p.status === "RANKED" ? (
            <div className="flex items-center gap-2">
              <div className="h-2 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className={cn("h-full rounded-full",
                    (p.score ?? 0) >= 70 ? "bg-success" : (p.score ?? 0) >= 45 ? "bg-amber-500" : "bg-red-400")}
                  style={{ width: `${p.score}%` }}
                />
              </div>
              <span className="font-bold">{faNumber(p.score)}</span>
            </div>
          ) : (
            <Badge tone={p.status === "EXCLUDED" ? "danger" : "default"}>
              {p.status === "EXCLUDED" ? "حذف‌شده" : "بدون داده"}
            </Badge>
          )}
        </td>
        <td className="px-4 py-3 text-xs">{m.volumeUsd24h != null ? `$${faNumber(Math.round(m.volumeUsd24h))}` : "—"}</td>
        <td className="px-4 py-3 text-xs">{faPercent(m.spreadPct)}</td>
        <td className="px-4 py-3 text-xs">{faPercent(m.slippagePct)}</td>
        <td className="px-4 py-3 text-xs">
          {faPercent(m.volatilityPct)}{m.volatilityEstimated ? "*" : ""}
        </td>
        <td className="px-4 py-3 text-xs font-medium">{faPercent(m.roundTripCostPct)}</td>
        <td className="px-4 py-3">
          {p.status !== "RANKED" ? "—" : p.partial ? (
            <Badge tone="warning">ناقص</Badge>
          ) : (
            <Badge tone="success">کامل</Badge>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-muted">{expanded ? "▲" : "▼"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={12} className="bg-slate-50 px-4 py-4 dark:bg-slate-800/30">
            <PairDetail p={p} />
          </td>
        </tr>
      )}
    </>
  );
}

function PairDetail({ p }: { p: PairRank }) {
  const m = p.metrics;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="mb-2 text-sm font-bold">جزئیات معیارها</div>
        <div className="space-y-1.5">
          {p.criteria.map((c) => (
            <div key={c.key} className="flex items-center gap-2 text-xs">
              <span className="w-32 shrink-0">{c.label}</span>
              <span className="w-20 shrink-0 text-muted">
                {c.raw !== null ? (c.unit === "$" ? `$${faNumber(Math.round(c.raw))}` : faPercent(c.raw)) : "—"}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                {c.score !== null && (
                  <div className="h-full rounded-full bg-primary" style={{ width: `${c.score}%` }} />
                )}
              </div>
              <span className="w-8 shrink-0 text-muted">{c.score !== null ? faNumber(Math.round(c.score)) : "—"}</span>
              <span className="w-10 shrink-0 text-muted">w {faNumber(c.weight)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1 text-xs text-muted">
          <div>آخرین به‌روزرسانی داده: {jalaliDateTime(p.updatedAt)}</div>
          <div>
            ارزش پوزیشن فرضی: ${faNumber(Math.round(m.notionalUsd ?? 0))}
            {(m.leverage ?? 1) > 1 && <> (مارجین ${faNumber(Math.round(m.marginUsd ?? 0))} × اهرم {faNumber(m.leverage)})</>}
          </div>
          {m.breakEvenMovePct != null && (
            <div>
              حداقل حرکت سودآور: {faPercent(m.breakEvenMovePct)}
              {(m.leverage ?? 1) > 1 && m.breakEvenMarginPct != null && (
                <> — معادل {faPercent(m.breakEvenMarginPct)} از مارجین</>
              )}
            </div>
          )}
          {m.markLastGapPct != null && (
            <div>
              فاصله مارک/لست: {faPercent(m.markLastGapPct)}
            </div>
          )}
          <div>
            فاندینگ‌ریت:{" "}
            {m.fundingRate != null ? (
              <>
                {faPercent(m.fundingRate)}
                {m.fundingNextRate != null && <> · پیش‌بینی بعدی: {faPercent(m.fundingNextRate)}</>}
                {m.fundingCountdownMs != null && <> · تسویه در {formatCountdown(m.fundingCountdownMs)}</>}
              </>
            ) : (
              <>ناموجود در این صرافی</>
            )}
          </div>
          <div>
            سود باز (OI):{" "}
            {m.openInterestUsd != null ? (
              <>${faNumber(Math.round(m.openInterestUsd))}
                {m.volToOi != null && <> · نسبت حجم/OI: {faNumber(m.volToOi, true)}</>}</>
            ) : (
              <>ناموجود در این صرافی</>
            )}
          </div>
          {m.volatilityEstimated && <div>* نوسان بر اساس بازه ۲۴ساعته برآورد شده (کندل در دسترس نبود)</div>}
        </div>
      </div>
      <div className="space-y-2 text-xs">
        {p.reasons.length > 0 && (
          <div>
            <div className="mb-1 font-bold text-red-600 dark:text-red-400">علت حذف</div>
            {p.reasons.map((r) => <div key={r} className="text-muted">• {r}</div>)}
          </div>
        )}
        {p.dataQuality.issues.length > 0 && (
          <div>
            <div className="mb-1 font-bold text-amber-600 dark:text-amber-400">هشدارهای داده</div>
            {p.dataQuality.issues.map((r) => <div key={r} className="text-muted">• {r}</div>)}
          </div>
        )}
        {m.slippageBuyPct != null && m.slippageSellPct != null && (
          <div className="text-muted">
            لغزش خرید: {faPercent(m.slippageBuyPct)} · لغزش فروش: {faPercent(m.slippageSellPct)}
            {m.depthUsd != null && <> · عمق ±۰٫۵٪: ${faNumber(Math.round(m.depthUsd))}</>}
          </div>
        )}
        {p.partial && p.status === "RANKED" && (
          <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-2 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            این امتیاز با بخشی از معیارها محاسبه شده — برای تحلیل کامل، جفت باید در لیست کوتاه نقدشونده‌ها باشد.
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-32 rounded-lg border border-border bg-card px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40";

function num(s: string) {
  return s.trim() !== "" && Number.isFinite(Number(s));
}

function formatCountdown(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return h > 0 ? `${faNumber(h)}س ${faNumber(min)}د` : `${faNumber(min)} دقیقه`;
}
