import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAccumulators } from "../lib/api";
import type { AccumulatorRecommendation } from "../lib/types";
import { RiskTierBadge } from "../components/RiskTierBadge";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: AccumulatorRecommendation[] };

const SELECTION_LABEL: Record<string, string> = { home: "Home", draw: "Draw", away: "Away" };

// The spec's own target order (Task.md's "Accumulator Engine" section) —
// only targets that actually have a current recommendation render a card;
// a target with no qualifying legs is omitted entirely rather than shown
// as an empty placeholder, since accumulator_targets can also be disabled.
const TARGET_ORDER = [5, 7, 10, 15, 20];

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function AccumulatorCardSkeleton() {
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <Skeleton className="mb-3 h-5 w-32" />
      <Skeleton className="mb-2 h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

function AccumulatorCard({ rec }: { rec: AccumulatorRecommendation }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">ACCA {rec.targetLegs}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">Target: ~{rec.targetLegs} odds</p>
        </div>
        <div className="flex items-center gap-2">
          {rec.isBestOverall && <Badge variant="success">Best overall</Badge>}
          <RiskTierBadge tier={rec.riskTier} />
        </div>
      </div>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Selections</dt>
          <dd className="tabular-nums">{rec.legs.length}</dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Combined odds</dt>
          <dd className="tabular-nums">{rec.combinedDecimalOdds !== null ? rec.combinedDecimalOdds.toFixed(2) : "Odds unavailable"}</dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Estimated probability</dt>
          <dd className="tabular-nums">{formatPercent(rec.combinedProbability)}</dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Accumulator score</dt>
          <dd className="tabular-nums">{rec.compositeScore.toFixed(0)}/100</dd>
        </div>
      </dl>

      {rec.correlationPenalty > 0 && (
        <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          Score reduced for shared-team overlap between legs (correlation penalty: {(rec.correlationPenalty * 100).toFixed(0)}%).
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-medium hover:underline">View {rec.legs.length} selections</summary>
        <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-900">
          {rec.legs.map((leg) => (
            <li key={leg.ensemblePredictionId} className="py-2 text-sm">
              <Link to={`/matches/${leg.fixtureId}`} className="hover:underline">
                {leg.homeTeamName ?? "Home"}
                <span className="mx-1 text-slate-400" aria-hidden="true">
                  v
                </span>
                {leg.awayTeamName ?? "Away"}
              </Link>
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>{SELECTION_LABEL[leg.selection] ?? leg.selection}</span>
                <span className="tabular-nums">{leg.odds !== null ? leg.odds.toFixed(2) : "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function Accumulators() {
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading" });
    getAccumulators(session.access_token)
      .then((res) => {
        if (!cancelled) setState({ status: "ready", rows: res.data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load accumulators" });
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadToken]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Accumulators</h1>
      <p className="mb-6 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Model-optimized accumulators per odds target. Legs are only ever added when they genuinely clear the
        target&apos;s score threshold — never padded to hit a leg count or chase a payout. Estimated probability and
        expected value are model outputs, not guarantees.
      </p>

      {state.status === "loading" && (
        <div role="status" aria-label="Loading accumulators" className="grid gap-4 sm:grid-cols-2">
          <AccumulatorCardSkeleton />
          <AccumulatorCardSkeleton />
        </div>
      )}

      {state.status === "error" && (
        <ErrorState message={`Data unavailable: ${state.message}`} onRetry={() => setReloadToken((t) => t + 1)} />
      )}

      {state.status === "ready" && state.rows.length === 0 && (
        <EmptyState
          title="No high-confidence accumulator today"
          description="No target currently has enough real, priced legs clearing its score threshold. The engine never forces a weak accumulator just to have something to show."
        />
      )}

      {state.status === "ready" && state.rows.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {TARGET_ORDER.filter((legs) => state.rows.some((r) => r.targetLegs === legs)).map((legs) => {
            const rec = state.rows.find((r) => r.targetLegs === legs)!;
            return <AccumulatorCard key={rec.id} rec={rec} />;
          })}
        </div>
      )}
    </div>
  );
}
