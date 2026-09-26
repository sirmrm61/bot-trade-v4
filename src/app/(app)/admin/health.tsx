"use client";

import { useEffect, useState } from "react";

const CHECKS = ["database", "redis", "worker", "nobitex", "queues"] as const;
const LABELS: Record<string, string> = {
  database: "دیتابیس", redis: "Redis", worker: "Worker", nobitex: "API نوبیتکس", queues: "صف‌ها",
};

export function HealthChecks() {
  const [results, setResults] = useState<Record<string, boolean | null>>({});

  useEffect(() => {
    for (const c of CHECKS) {
      fetch(`/api/health/${c}`)
        .then((r) => setResults((s) => ({ ...s, [c]: r.ok })))
        .catch(() => setResults((s) => ({ ...s, [c]: false })));
    }
  }, []);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {CHECKS.map((c) => (
        <div key={c} className="rounded-xl border border-border p-3 text-center">
          <div className="text-sm text-muted">{LABELS[c]}</div>
          <div className={`mt-1 font-bold ${results[c] === null || results[c] === undefined ? "text-muted" : results[c] ? "text-success" : "text-danger"}`}>
            {results[c] === null || results[c] === undefined ? "…" : results[c] ? "سالم" : "خطا"}
          </div>
        </div>
      ))}
    </div>
  );
}
