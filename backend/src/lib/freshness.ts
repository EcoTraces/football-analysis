export type Freshness = "LIVE" | "RECENT" | "STALE" | "UNAVAILABLE";

export type FreshnessDomain = "fixtures" | "injuries" | "lineups" | "results" | "standings" | "predictions" | "odds";

export interface FreshnessPolicy {
  /** Age (ms) below which data counts as LIVE. */
  liveMs: number;
  /** Age (ms) below which data counts as RECENT (beyond liveMs). */
  recentMs: number;
}

// Section 6 of the spec: different data types tolerate different staleness.
// Keyed by a closed union (not `string`) so lookups below are exhaustive and
// never produce `undefined` under noUncheckedIndexedAccess.
export const FRESHNESS_POLICIES: Record<FreshnessDomain, FreshnessPolicy> = {
  fixtures: { liveMs: 5 * 60_000, recentMs: 6 * 60 * 60_000 },
  injuries: { liveMs: 60 * 60_000, recentMs: 24 * 60 * 60_000 },
  lineups: { liveMs: 15 * 60_000, recentMs: 2 * 60 * 60_000 },
  results: { liveMs: 10 * 60_000, recentMs: 24 * 60 * 60_000 },
  standings: { liveMs: 60 * 60_000, recentMs: 24 * 60 * 60_000 },
  predictions: { liveMs: 60 * 60_000, recentMs: 12 * 60 * 60_000 },
  odds: { liveMs: 5 * 60_000, recentMs: 60 * 60_000 }
};

export function classifyFreshness(
  sourceTimestamp: string | Date | null | undefined,
  policyKey: FreshnessDomain,
  now: Date = new Date()
): Freshness {
  if (!sourceTimestamp) return "UNAVAILABLE";
  const ts = typeof sourceTimestamp === "string" ? new Date(sourceTimestamp) : sourceTimestamp;
  if (Number.isNaN(ts.getTime())) return "UNAVAILABLE";

  const ageMs = now.getTime() - ts.getTime();
  const policy: FreshnessPolicy = FRESHNESS_POLICIES[policyKey];
  if (ageMs < 0) return "LIVE"; // clock skew tolerance — treat as freshest bucket
  if (ageMs <= policy.liveMs) return "LIVE";
  if (ageMs <= policy.recentMs) return "RECENT";
  return "STALE";
}
