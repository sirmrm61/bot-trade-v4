import { describe, it, expect } from "vitest";
import { shouldLogEpisode } from "@/modules/trading/signal-log";

describe("signal-log episode dedupe", () => {
  it("never logs HOLD", () => {
    expect(shouldLogEpisode(null, "HOLD", false)).toBe(false);
    expect(shouldLogEpisode("BUY", "HOLD", true)).toBe(false);
  });

  it("logs the first tick of a new episode only", () => {
    expect(shouldLogEpisode(null, "BUY", false)).toBe(true);   // fresh episode
    expect(shouldLogEpisode("SELL", "BUY", false)).toBe(true); // signal flipped
    expect(shouldLogEpisode("BUY", "BUY", false)).toBe(false); // same episode repeats
  });

  it("always logs an actual entry even mid-episode", () => {
    expect(shouldLogEpisode("BUY", "BUY", true)).toBe(true);
  });
});
