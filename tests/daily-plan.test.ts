import { describe, it, expect } from "vitest";
import { decideState, dailyEntryGate } from "@/modules/trading/daily-plan";
import { evalForecast } from "@/modules/forecast/service";

const plan = (state: string, lockedReason: string | null = null) =>
  ({ state, lockedReason }) as Parameters<typeof dailyEntryGate>[0];

describe("decideState — daily state transitions", () => {
  it("BUILDING → PROTECTING at the normal target", () => {
    expect(decideState("BUILDING", 1.2, 1.2).state).toBe("PROTECTING");
  });

  it("BUILDING → LOCKED at the stretch target", () => {
    const d = decideState("BUILDING", 5.2, 5.2);
    expect(d.state).toBe("LOCKED");
    expect(d.lockedReason).toContain("تلاشی");
  });

  it("BUILDING → DEFENSIVE below the −1% line", () => {
    expect(decideState("BUILDING", -1.5, 0).state).toBe("DEFENSIVE");
    expect(decideState("BUILDING", -0.9, 0).state).toBe("BUILDING");
  });

  it("PROTECTING → LOCKED on >40% give-back of peak", () => {
    // peak 2%, now 1.1% → gave back 45%
    const d = decideState("PROTECTING", 1.1, 2);
    expect(d.state).toBe("LOCKED");
    expect(d.lockedReason).toContain("اوج");
  });

  it("PROTECTING holds on ≤40% give-back", () => {
    expect(decideState("PROTECTING", 1.4, 2).state).toBe("PROTECTING");
  });

  it("LOCKED is sticky — never unlocks within the day", () => {
    const d = decideState("LOCKED", -5, 5, "قفل شد");
    expect(d.state).toBe("LOCKED");
    expect(d.lockedReason).toBe("قفل شد");
  });
});

describe("dailyEntryGate — per-state policy", () => {
  it("BUILDING: full size, floor 0.58", () => {
    const g = dailyEntryGate(plan("BUILDING"));
    expect(g.allow).toBe(true);
    expect(g.sizeScale).toBe(1);
    expect(g.minForecastP).toBe(0.58);
  });

  it("PROTECTING: half size, raised floors", () => {
    const g = dailyEntryGate(plan("PROTECTING"));
    expect(g.allow).toBe(true);
    expect(g.sizeScale).toBe(0.5);
    expect(g.minForecastP).toBeGreaterThan(0.58);
    expect(g.minScoreBoost).toBeGreaterThan(0);
  });

  it("DEFENSIVE: half size, strictest floors", () => {
    const g = dailyEntryGate(plan("DEFENSIVE"));
    expect(g.sizeScale).toBe(0.5);
    expect(g.minForecastP).toBeGreaterThan(0.6);
  });

  it("LOCKED: no entries, reason surfaced", () => {
    const g = dailyEntryGate(plan("LOCKED", "روز قفل شد"));
    expect(g.allow).toBe(false);
    expect(g.sizeScale).toBe(0);
    expect(g.reason).toBe("روز قفل شد");
  });
});

describe("evalForecast — probability/EV/Kelly gate", () => {
  it("rejects below the probability floor", () => {
    const r = evalForecast({ pDir: 0.55, tpPct: 5, slPct: 2 });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("احتمال");
  });

  it("rejects negative EV after costs", () => {
    // p=0.6, tp=1, sl=3 → EV = 0.6 − 1.2 − cost < 0
    const r = evalForecast({ pDir: 0.6, tpPct: 1, slPct: 3 });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("ارزش");
  });

  it("allows strong probability + positive EV", () => {
    const r = evalForecast({ pDir: 0.62, tpPct: 5, slPct: 2 });
    expect(r.allow).toBe(true);
    expect(r.ev).toBeGreaterThan(0);
  });

  it("size multiplier stays in [0.5, 1] — edge shrinks, never grows", () => {
    for (const p of [0.58, 0.65, 0.75, 0.95]) {
      const r = evalForecast({ pDir: p, tpPct: 5, slPct: 2 });
      expect(r.sizeMult).toBeGreaterThanOrEqual(0.5);
      expect(r.sizeMult).toBeLessThanOrEqual(1);
    }
  });

  it("daily plan floor can raise the threshold", () => {
    const ok = evalForecast({ pDir: 0.6, tpPct: 5, slPct: 2 });
    const strict = evalForecast({ pDir: 0.6, tpPct: 5, slPct: 2, minP: 0.66 });
    expect(ok.allow).toBe(true);
    expect(strict.allow).toBe(false);
  });
});
