import type { Freshness } from "../lib/types";
import { Badge, type BadgeVariant } from "./Badge";

const VARIANT: Record<Freshness, BadgeVariant> = {
  LIVE: "success",
  RECENT: "info",
  STALE: "warning",
  UNAVAILABLE: "neutral"
};

const LABEL: Record<Freshness, string> = {
  LIVE: "Live",
  RECENT: "Recent",
  STALE: "Stale",
  UNAVAILABLE: "Data unavailable"
};

// Freshness is never communicated by color alone (spec section 35) — the
// label text carries the meaning, color is a secondary reinforcement.
export function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  return (
    <Badge variant={VARIANT[freshness]} role="status">
      {LABEL[freshness]}
    </Badge>
  );
}
