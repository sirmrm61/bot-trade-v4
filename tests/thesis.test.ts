import { describe, it, expect } from "vitest";
import { tradeThesis } from "@/modules/trading/thesis";

const base = {
  side: "LONG", entryPrice: 100,
  stopLossPrice: 98, takeProfitPrice: 105, meta: null as string | null,
};

describe("tradeThesis", () => {
  it("renders the numeric plan from SL/TP", () => {
    const th = tradeThesis(base);
    expect(th.plan).toContain("+۵٪");
    expect(th.plan).toContain("−۲٪");
    expect(th.plan).toContain("R:R ۲٫۵");
  });

  it("mirrors the plan for SHORT", () => {
    const th = tradeThesis({
      ...base, side: "SHORT", stopLossPrice: 103, takeProfitPrice: 94,
    });
    expect(th.plan).toContain("+۶٪");
    expect(th.plan).toContain("−۳٪");
  });

  it("no SL/TP → no plan line but no crash", () => {
    const th = tradeThesis({ ...base, stopLossPrice: null, takeProfitPrice: null });
    expect(th.plan).toBeNull();
  });

  it("renders the entry snapshot as Persian why-lines", () => {
    const th = tradeThesis({
      ...base,
      meta: JSON.stringify({
        signal: "BUY", score: 0.7,
        features: {
          label: "شکست سقف",
          quality: { score: 0.72, regime: "trending" },
          forecast: { p: 0.61, ev: 1.3, horizon: "4h" },
          breakdown: [
            { name: "RSI", weight: 1, score: 0.8, contribution: 0.6 },
            { name: "EMA", weight: 1, score: -0.3, contribution: -0.2 },
          ],
        },
      }),
    });
    const all = th.why.join("\n");
    expect(all).toContain("شکست سقف");
    expect(all).toContain("امتیاز ورود ۷۲٪");
    expect(all).toContain("رژیم رونددار");
    expect(all).toContain("پیش‌بینی مدل ۶۱٪ (افق 4h)");
    expect(all).toContain("RSI (+۰٫۶)");
    expect(th.source).toBe("signal");
  });

  it("agent trades: source chip + free-text reason first", () => {
    const th = tradeThesis({
      ...base,
      meta: JSON.stringify({ source: "agent", thesis: "شکست مقاومت ۴ ساعته", features: {} }),
    });
    expect(th.source).toBe("agent");
    expect(th.why[0]).toBe("شکست مقاومت ۴ ساعته");
  });

  it("empty meta → empty why, signal source", () => {
    const th = tradeThesis({ ...base, meta: "{}" });
    expect(th.why).toEqual([]);
    expect(th.source).toBe("signal");
  });

  it("tolerates corrupt meta JSON", () => {
    const th = tradeThesis({ ...base, meta: "{not json" });
    expect(th.plan).not.toBeNull();
    expect(th.why).toEqual([]);
  });
});
