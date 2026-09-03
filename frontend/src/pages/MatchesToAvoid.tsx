import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMatchesToAvoid } from "../lib/api";
import type { EnsemblePredictionRow } from "../lib/types";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: EnsemblePredictionRow[] };

const SELECTION_LABEL: Record<string, string> = { home: "Home", draw: "Draw", away: "Away" };

// A row can match more than one reason at once (e.g. high_risk AND
// insufficient data) — every reason that applies is shown, not just the
// first one, so the actual basis for the flag is never hidden.
function reasonsFor(row: EnsemblePredictionRow): string[] {
  const reasons: string[] = [];
  if (row.riskTier === "avoid") reasons.push("Avoid tier");
  if (row.riskTier === "high_risk") reasons.push("High risk");
  if (row.consensusLevel === "conflicting") reasons.push("Conflicting signals");
  if (row.dataQuality === "insufficient") reasons.push("Insufficient data");
  return reasons;
}

function RowSkeleton() {
  return (
    <li className="space-y-2 py-4">
      <Skeleton className="h-4 w-3/4 max-w-xs" />
      <Skeleton className="h-3 w-40" />
    </li>
  );
}

export function MatchesToAvoid() {
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading" });
    getMatchesToAvoid(session.access_token)
      .then((res) => {
        if (!cancelled) setState({ status: "ready", rows: res.data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load matches to avoid" });
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadToken]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Matches to avoid</h1>
      <p className="mb-6 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Selections the model itself flags as unreliable — conflicting signals between components, too little data,
        or a risk tier below what the accumulator engine will use. Knowing when not to bet is as much a part of
        this tool as the picks in Top 20.
      </p>

      {state.status === "loading" && (
        <ul role="status" aria-label="Loading matches to avoid" className="divide-y divide-slate-200 dark:divide-slate-800">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </ul>
      )}

      {state.status === "error" && (
        <ErrorState message={`Data unavailable: ${state.message}`} onRetry={() => setReloadToken((t) => t + 1)} />
      )}

      {state.status === "ready" && state.rows.length === 0 && (
        <EmptyState
          title="Nothing flagged right now"
          description="No currently-screened selection is conflicted, high-risk, or short on data. This list is expected to be empty on a quiet day."
        />
      )}

      {state.status === "ready" && state.rows.length > 0 && (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {state.rows.map((row) => (
            <li key={row.id} className="py-4">
              <Link to={`/matches/${row.fixtureId}`} className="block hover:underline">
                <p className="font-medium">
                  {row.homeTeamName ?? "Home"}
                  <span className="mx-1 text-slate-400" aria-hidden="true">
                    v
                  </span>
                  {row.awayTeamName ?? "Away"}
                  <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                    — {SELECTION_LABEL[row.selection] ?? row.selection}
                  </span>
                </p>
                {row.competitionName && <p className="text-xs text-slate-500 dark:text-slate-400">{row.competitionName}</p>}
              </Link>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {reasonsFor(row).map((reason) => (
                  <Badge key={reason} variant="warning">
                    {reason}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
