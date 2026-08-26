import { describe, expect, it } from "vitest";
import { todayRangeUtc } from "../services/fixturesService.js";

describe("todayRangeUtc", () => {
  it("returns a 24h UTC window starting at midnight", () => {
    const now = new Date("2026-08-26T15:42:00Z");
    const { from, to } = todayRangeUtc(now);
    expect(from).toBe("2026-08-26T00:00:00.000Z");
    expect(to).toBe("2026-08-27T00:00:00.000Z");
  });
});
