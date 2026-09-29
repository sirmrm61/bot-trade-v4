"use client";

import { useState } from "react";
import { Modal } from "@/components/client";
import { RunBacktestForm, PaperTestForm, GoLiveForm } from "./[id]/actions";

type DialogKind = "backtest" | "paper" | "live" | null;

function defaultDates() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

/** Inline per-strategy actions on the list page — each opens a dialog that
 *  collects its inputs instead of navigating to the detail page. */
export function StrategyRowActions({
  strategyId,
  versionId,
  strategyName,
  hasBacktest,
}: {
  strategyId: string;
  versionId?: string;
  strategyName: string;
  hasBacktest: boolean;
}) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const dates = defaultDates();

  const btn =
    "rounded-lg border border-border px-2 py-1 text-xs font-bold transition hover:border-primary/50 hover:bg-primary/5 hover:text-primary";

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setDialog("backtest")} className={btn}>
          بک‌تست
        </button>
        <button type="button" onClick={() => setDialog("paper")} className={btn}>
          تست زنده
        </button>
        <button
          type="button"
          onClick={() => setDialog("live")}
          className="rounded-lg border border-success/40 px-2 py-1 text-xs font-bold text-success transition hover:bg-success/10"
        >
          لایو واقعی
        </button>
      </div>

      <Modal open={dialog === "backtest"} onClose={() => setDialog(null)} title={`بک‌تست — ${strategyName}`}>
        <RunBacktestForm
          strategyId={strategyId}
          versionId={versionId}
          defaultFrom={dates.from}
          defaultTo={dates.to}
          onDone={() => setDialog(null)}
        />
      </Modal>

      <Modal open={dialog === "paper"} onClose={() => setDialog(null)} title={`تست معاملات زنده — ${strategyName}`}>
        <PaperTestForm strategyId={strategyId} versionId={versionId} onDone={() => setDialog(null)} />
      </Modal>

      <Modal open={dialog === "live"} onClose={() => setDialog(null)} title={`معاملات زنده واقعی — ${strategyName}`}>
        <GoLiveForm strategyId={strategyId} versionId={versionId} hasBacktest={hasBacktest} onDone={() => setDialog(null)} />
      </Modal>
    </>
  );
}
