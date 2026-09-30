"use client";

import { useMemo, useState } from "react";
import { Spinner, Field, Select, Input } from "@/components/client";
import { toast } from "@/components/toast";
import { useRouter } from "next/navigation";

/**
 * Smart Grid dialog — creates a GRID strategy then optionally starts a
 * paper/live run or queues a backtest. The grid module handles the rest
 * (anchored ladder, ATR-smart spacing, re-centering on drift).
 */
export function GridDialog({ pairs }: { pairs: { symbol: string; exchange: string }[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState("");
  const [exchange, setExchange] = useState("KUCOIN");
  const [timeframe, setTimeframe] = useState("5m");
  const [capital, setCapital] = useState("200");
  const [levels, setLevels] = useState("5");
  const [rangePct, setRangePct] = useState("4");
  const [stepPct, setStepPct] = useState("0.8");
  const [atrMult, setAtrMult] = useState("1.2");
  const [busy, setBusy] = useState<"PAPER" | "REAL" | "BT" | null>(null);

  const symbols = useMemo(() => [...new Set(pairs.map((p) => p.symbol))].sort(), [pairs]);
  function pick(v: string) {
    setSymbol(v);
    const hit = pairs.find((p) => p.symbol === v.toUpperCase().trim());
    if (hit) setExchange(hit.exchange);
  }

  async function run(action: "PAPER" | "REAL" | "BT") {
    const sym = symbol.trim().toUpperCase();
    if (!sym) { toast.error("نماد را انتخاب کنید"); return; }
    setBusy(action);
    try {
      const createRes = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `گرید ${sym}`,
          kind: "GRID",
          symbol: sym,
          exchange,
          timeframe,
          buyThreshold: 0.5, sellThreshold: -0.5, // unused — validation early-returns for GRID
          riskPerTradePct: 5, stopLossPct: 0, takeProfitPct: 0,
          market: "SPOT", orderType: "LIMIT",
          indicators: [],
          grid: {
            rangePct: Number(rangePct) || 4,
            levels: Math.trunc(Number(levels)) || 5,
            stepPct: Number(stepPct) || 0.8,
            atrStepMult: Number(atrMult) || 1.2,
            orderSizePct: 15,
            recenterPct: Number(rangePct) || 4,
          },
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) { toast.error(created.error ?? "ساخت استراتژی ناموفق بود"); return; }

      if (action === "BT") {
        const end = new Date();
        const start = new Date(Date.now() - 14 * 86_400_000);
        const bt = await fetch("/api/backtests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strategyId: created.strategy.id,
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
            initialBalance: Number(capital) || 200,
          }),
        });
        const btJson = await bt.json();
        if (!bt.ok) toast.error(btJson.error ?? "بک‌تست ناموفق بود");
        else { toast.success("استراتژی ساخته شد و بک‌تست در صف قرار گرفت"); router.push("/backtests"); }
        return;
      }

      const live = await fetch("/api/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyId: created.strategy.id,
          allocatedCapital: Number(capital) || 200,
          mode: action,
        }),
      });
      const liveJson = await live.json();
      if (!live.ok) toast.error(liveJson.error ?? "شروع لایو ناموفق بود");
      else {
        toast.success(action === "PAPER" ? "گرید در حالت تست زنده فعال شد" : "گرید واقعی فعال شد");
        router.push("/live");
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-6 text-muted">
        گرید هوشمند یک نردبان سفارش‌های لیمیت دور قیمت می‌چیند — خرید پایین، فروش بالا.
        فاصله‌ی پله‌ها با ATR بازار تطبیق می‌یابد و اگر قیمت از باند خارج شود نردبان بازچینی می‌شود.
        فقط اسپات. سود هر چرخه ≈ فاصله‌ی پله منهای کارمزد رفت‌وبرگشت.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="نماد" help="جفت‌ارزی که گرید روی آن اجرا شود — بازار رنج‌شکن بهترین است">
          <Input dir="ltr" list="grid-symbols" placeholder="BTC-USDT" value={symbol} onChange={(e) => pick(e.target.value)} />
          <datalist id="grid-symbols">
            {symbols.map((s) => <option key={s} value={s} />)}
          </datalist>
        </Field>
        <Field label="صرافی">
          <Select value={exchange} onChange={(e) => setExchange(e.target.value)}>
            <option value="KUCOIN">کوکوین</option>
            <option value="NOBITEX">نوبیتکس</option>
          </Select>
        </Field>
        <Field label="تایم‌فریم" help="برای محاسبه‌ی ATR — گام هوشمند پله‌ها">
          <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
            {["1m", "3m", "5m", "15m", "30m", "1h"].map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="سرمایه"><Input type="number" min={10} value={capital} onChange={(e) => setCapital(e.target.value)} dir="ltr" /></Field>
        <Field label="تعداد پله در هر سمت" help="۳–۱۰ معمول است"><Input type="number" min={1} max={25} value={levels} onChange={(e) => setLevels(e.target.value)} dir="ltr" /></Field>
        <Field label="باند گرید ٪" help="نیم‌پهنای باند دور لنگر — خروج قیمت = بازچینی"><Input type="number" min={0.2} max={50} step={0.1} value={rangePct} onChange={(e) => setRangePct(e.target.value)} dir="ltr" /></Field>
        <Field label="حداقل فاصله‌ی پله ٪" help="کف فاصله — با ATR ممکن است بیشتر شود"><Input type="number" min={0.05} max={20} step={0.05} value={stepPct} onChange={(e) => setStepPct(e.target.value)} dir="ltr" /></Field>
        <Field label="ضریب ATR" help="گام ≥ ATR٪ × این ضریب — ۰ یعنی غیرفعال"><Input type="number" min={0} max={10} step={0.1} value={atrMult} onChange={(e) => setAtrMult(e.target.value)} dir="ltr" /></Field>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button type="button" onClick={() => run("PAPER")} disabled={busy !== null}
          className="rounded-xl bg-success px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-50">
          {busy === "PAPER" ? <Spinner /> : "ساخت + تست زنده"}
        </button>
        <button type="button" onClick={() => run("BT")} disabled={busy !== null}
          className="rounded-xl border border-primary px-4 py-2.5 text-sm font-bold text-primary transition hover:bg-primary/5 disabled:opacity-50">
          {busy === "BT" ? <Spinner /> : "ساخت + بک‌تست"}
        </button>
        <button type="button" onClick={() => run("REAL")} disabled={busy !== null}
          className="rounded-xl bg-danger px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-50">
          {busy === "REAL" ? <Spinner /> : "ساخت + معامله‌ی واقعی"}
        </button>
      </div>
      <p className="text-[11px] text-muted">
        حالت واقعی نیازمند اکانت متصل صرافی و بک‌تست موفق است — در صورت نبود بک‌تست، اول «ساخت + بک‌تست» را بزنید.
      </p>
    </div>
  );
}
