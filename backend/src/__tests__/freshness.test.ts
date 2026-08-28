import { describe, expect, it } from "vitest";
import { classifyFreshness } from "../lib/freshness.js";

describe("classifyFreshness", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("returns UNAVAILABLE when there is no timestamp", () => {
    expect(classifyFreshness(null, "fixtures", now)).toBe("UNAVAILABLE");
    expect(classifyFreshness(undefined, "fixtures", now)).toBe("UNAVAILABLE");
  });

  it("returns UNAVAILABLE for an unparseable timestamp", () => {
    expect(classifyFreshness("not-a-date", "fixtures", now)).toBe("UNAVAILABLE");
  });

  it("classifies fixtures within 5 minutes as LIVE", () => {
    const ts = new Date(now.getTime() - 2 * 60_000).toISOString();
    expect(classifyFreshness(ts, "fixtures", now)).toBe("LIVE");
  });

  it("classifies fixtures within 6 hours (but beyond 5 min) as RECENT", () => {
    const ts = new Date(now.getTime() - 60 * 60_000).toISOString();
    expect(classifyFreshness(ts, "fixtures", now)).toBe("RECENT");
  });

  it("classifies fixtures older than 6 hours as STALE", () => {
    const ts = new Date(now.getTime() - 7 * 60 * 60_000).toISOString();
    expect(classifyFreshness(ts, "fixtures", now)).toBe("STALE");
  });

  it("uses the injuries policy's wider LIVE window", () => {
    const ts = new Date(now.getTime() - 30 * 60_000).toISOString();
    expect(classifyFreshness(ts, "injuries", now)).toBe("LIVE");
  });

  it("uses the same once-daily-cadence policy for fixtureStatistics as teamStatistics", () => {
    const ts = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    expect(classifyFreshness(ts, "fixtureStatistics", now)).toBe("LIVE");
    expect(classifyFreshness(ts, "fixtureStatistics", now)).toBe(classifyFreshness(ts, "teamStatistics", now));
  });

  it("uses the same once-daily-cadence policy for playerStatistics as teamStatistics", () => {
    const ts = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    expect(classifyFreshness(ts, "playerStatistics", now)).toBe("LIVE");
    expect(classifyFreshness(ts, "playerStatistics", now)).toBe(classifyFreshness(ts, "teamStatistics", now));
  });
});
