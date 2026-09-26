"use client";

import { useState } from "react";

export function SettingField({ name, value, description }: { name: string; value: unknown; description?: string | null }) {
  const [v, setV] = useState(String(value ?? ""));
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    const num = Number(v);
    const res = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: name, value: Number.isNaN(num) ? v : num }),
    });
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
    else setErr((await res.json().catch(() => ({}))).error ?? "خطا");
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="font-mono text-sm font-bold ltr">{name}</div>
        {description && <div className="text-xs text-muted">{description}</div>}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          className="w-28 rounded-lg border border-border bg-card px-2 py-1.5 text-sm ltr"
        />
        <button onClick={save} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground">
          {saved ? "✓" : "ذخیره"}
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}
