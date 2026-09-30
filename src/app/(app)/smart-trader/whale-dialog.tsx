"use client";

import { useEffect, useState } from "react";
import { Spinner, Field, Select, Input } from "@/components/client";
import { Badge, EmptyState } from "@/components/ui";
import { toast } from "@/components/toast";
import { cn } from "@/shared/utils";

interface WhaleEvent {
  id: string;
  exchange: string;
  symbol: string;
  marketType: string;
  kind: "BID_WALL" | "ASK_WALL" | "IMBALANCE_BIDS" | "IMBALANCE_ASKS";
  mid: number;
  price: number | null;
  sizeUsd: number | null;
  distancePct: number | null;
  sharePct: number | null;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalance: number;
  score: number;
  reasons: string;
  createdAt: string;
}

const KIND_LABEL: Record<string, { label: string; tone: "success" | "danger" | "info" | "warning" }> = {
  BID_WALL: { label: "دیوار خرید", tone: "success" },
  ASK_WALL: { label: "دیوار فروش", tone: "danger" },
  IMBALANCE_BIDS: { label: "فشار خرید", tone: "info" },
  IMBALANCE_ASKS: { label: "فشار فروش", tone: "warning" },
};

const fmtUsd = (v: number | null) =>
  v === null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(0)}K`;

export function WhaleDialog() {
  const [market, setMarket] = useState("");
  const [count, setCount] = useState("10");
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<WhaleEvent[]>([]);
  const [history, setHistory] = useState<WhaleEvent[]>([]);

  useEffect(() => {
    fetch("/api/whales?take=20")
      .then((r) => r.json())
      .then((j) => { if (j.items) setHistory(j.items); })
      .catch(() => {});
  }, []);

  async function scan() {
    setScanning(true);
    try {
      const res = await fetch("/api/whales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: market || undefined, count: Number(count) || 10 }),
      });
      const json = await res.json();
      if (!res.ok) toast.error(json.error ?? "اسکن ناموفق بود");
      else {
        setResults(json.events ?? []);
        toast.success(json.found > 0 ? `${json.found} رویداد نهنگ در ${json.scanned} جفت پیدا شد` : "رویداد نهنگی پیدا نشد");
        const h = await fetch("/api/whales?take=20").then((r) => r.json()).catch(() => null);
        if (h?.items) setHistory(h.items);
      }
    } catch {
      toast.error("خطای غیرمنتظره‌ای رخ داد");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="بازار">
          <Select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">همه</option>
            <option value="SPOT">اسپات</option>
            <option value="PERPETUAL">پرپچوال</option>
          </Select>
        </Field>
        <Field label="حداکثر رویداد">
          <Input type="number" min={1} max={25} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <button type="button" onClick={scan} disabled={scanning}
            className="w-full rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {scanning ? <span className="inline-flex items-center gap-2"><Spinner />در حال اسکن…</span> : "اسکن اوردر‌بوک"}
          </button>
        </div>
      </div>

      {scanning ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-10">
          <Spinner className="size-8" />
          <span className="text-sm text-muted">در حال خواندن اوردر‌بوک جفت‌های برتر…</span>
        </div>
      ) : results.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-bold">رویدادهای تازه</h4>
          {results.map((e) => <WhaleCard key={e.id} e={e} />)}
        </div>
      ) : null}

      <div>
        <h4 className="mb-2 text-sm font-bold">تاریخچه‌ی رویدادها</h4>
        {history.length === 0 ? (
          <EmptyState title="هنوز رویدادی ثبت نشده" hint="اسکن اوردر‌بوک را اجرا کنید" />
        ) : (
          <div className="space-y-1.5">
            {history.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                <span className="font-bold" dir="ltr">{e.symbol}</span>
                <Badge tone={KIND_LABEL[e.kind]?.tone ?? "default"}>{KIND_LABEL[e.kind]?.label ?? e.kind}</Badge>
                {e.sizeUsd !== null && <span className="text-muted">{fmtUsd(e.sizeUsd)}</span>}
                <span className="text-muted">عدم تعادل {e.imbalance.toFixed(1)}×</span>
                <span className="ms-auto text-muted" dir="ltr">{new Date(e.createdAt).toLocaleString("fa-IR")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WhaleCard({ e }: { e: WhaleEvent }) {
  const [expanded, setExpanded] = useState(false);
  const reasons = (() => { try { return JSON.parse(e.reasons) as string[]; } catch { return []; } })();
  const meta = KIND_LABEL[e.kind] ?? { label: e.kind, tone: "default" as const };

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-black" dir="ltr">{e.symbol}</span>
        <Badge tone="info">{e.exchange}</Badge>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <Badge tone="default">{e.marketType === "PERPETUAL" ? "پرپچوال" : "اسپات"}</Badge>
        <span className="ms-auto flex items-center gap-1 text-xs">
          <span className="text-muted">قدرت</span>
          <span className={cn("font-black", e.score >= 70 ? "text-success" : e.score >= 45 ? "text-warning" : "text-muted")}>{e.score}</span>
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center sm:grid-cols-5">
        <Cell label="قیمت میانی" v={e.mid.toLocaleString("en-US", { maximumFractionDigits: 4 })} />
        <Cell label="سطح دیوار" v={e.price?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? "—"} />
        <Cell label="حجم دیوار" v={fmtUsd(e.sizeUsd)} />
        <Cell label="فاصله" v={e.distancePct !== null ? `${e.distancePct}٪` : "—"} />
        <Cell label="سهم از عمق" v={e.sharePct !== null ? `${e.sharePct}٪` : "—"} />
      </div>

      {expanded && reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pe-4 text-xs text-muted">
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-2 text-xs font-bold text-primary hover:underline">
        {expanded ? "بستن جزئیات ↑" : "جزئیات ↓"}
      </button>
    </div>
  );
}

function Cell({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/50">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="text-xs font-black" dir="ltr">{v}</div>
    </div>
  );
}
