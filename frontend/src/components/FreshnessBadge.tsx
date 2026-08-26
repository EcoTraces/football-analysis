import type { Freshness } from "../lib/types";

const STYLES: Record<Freshness, { label: string; className: string }> = {
  LIVE: { label: "Live", className: "bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-100" },
  RECENT: { label: "Recent", className: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100" },
  STALE: { label: "Stale", className: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" },
  UNAVAILABLE: { label: "Data unavailable", className: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300" }
};

// Freshness is never communicated by color alone (spec section 35) — the
// label text carries the meaning, color is a secondary reinforcement.
export function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  const style = STYLES[freshness];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}
      role="status"
    >
      {style.label}
    </span>
  );
}
