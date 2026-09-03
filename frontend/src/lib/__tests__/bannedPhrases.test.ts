import { describe, expect, it } from "vitest";
import { assertNoBannedPhrases, findBannedPhrases } from "../bannedPhrases";

describe("findBannedPhrases", () => {
  it("returns an empty array for clean, hedged copy", () => {
    expect(findBannedPhrases("This is a model probability, not a guarantee.")).toEqual([]);
  });

  it("finds a banned phrase regardless of case", () => {
    expect(findBannedPhrases("This is a GUARANTEED WIN.")).toEqual(["guaranteed win"]);
  });

  it("finds every banned phrase present, not just the first", () => {
    const found = findBannedPhrases("A risk-free banker, 100% sure to land.");
    expect(found.sort()).toEqual(["100% sure", "banker", "risk-free"].sort());
  });
});

describe("assertNoBannedPhrases", () => {
  it("does not throw for clean copy", () => {
    expect(() => assertNoBannedPhrases("Estimated probability: 62%. Risk: medium.")).not.toThrow();
  });

  it("throws naming the offending phrase for tainted copy", () => {
    expect(() => assertNoBannedPhrases("Today's fixed match.")).toThrow(/fixed match/);
  });
});
