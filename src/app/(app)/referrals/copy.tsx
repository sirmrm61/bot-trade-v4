"use client";

import { useState } from "react";

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={link} dir="ltr" className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm" />
      <button
        onClick={() => { navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="shrink-0 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
      >
        {copied ? "کپی شد ✓" : "کپی"}
      </button>
    </div>
  );
}
