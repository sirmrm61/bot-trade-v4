"use client";

import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";

/** Equity curve chart for backtest results. */
export function EquityChart({ data }: { data: { t: number; equity: number }[] }) {
  const points = data.map((d) => ({
    t: new Date(d.t).toLocaleDateString("fa-IR"),
    equity: Math.round(d.equity),
  }));
  return (
    <div dir="ltr" className="h-72 w-full">
      <ResponsiveContainer>
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v / 1e6).toFixed(1) + "M"} width={56} />
          <Tooltip formatter={(v) => [Number(v).toLocaleString("fa-IR"), "موجودی"]} />
          <Area type="monotone" dataKey="equity" stroke="#2563eb" fill="url(#eq)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
