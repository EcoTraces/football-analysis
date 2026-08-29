import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTodayFixtures } from "../lib/api";
import type { FixtureSummary } from "../lib/types";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; fixtures: FixtureSummary[] };

function FixtureRowSkeleton() {
  return (
    <li className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4 max-w-xs" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-5 w-16 shrink-0" />
    </li>
  );
}

export function FixturesToday() {
  // This page only ever renders inside <RequireAuth>, which doesn't render
  // its children until status is "signed-in" — session.access_token is
  // guaranteed to exist by then.
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Bumped by the retry button to re-run the effect below without
  // duplicating its fetch logic in a second function.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading" });
    getTodayFixtures(session.access_token)
      .then((res) => {
        if (!cancelled) setState({ status: "ready", fixtures: res.data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load fixtures" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadToken]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Today&apos;s fixtures</h1>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        All times UTC. Only fixtures from a configured, verified data source are shown here — see the
        freshness badge on each match.
      </p>

      {state.status === "loading" && (
        <ul role="status" aria-label="Loading fixtures" className="divide-y divide-slate-200 dark:divide-slate-800">
          <FixtureRowSkeleton />
          <FixtureRowSkeleton />
          <FixtureRowSkeleton />
        </ul>
      )}

      {state.status === "error" && (
        <ErrorState message={`Data unavailable: ${state.message}`} onRetry={() => setReloadToken((t) => t + 1)} />
      )}

      {state.status === "ready" && state.fixtures.length === 0 && (
        <EmptyState
          title="No fixtures available for today"
          description="This platform ships with no football data provider configured by default — see Data_Sources.md to connect one."
        />
      )}

      {state.status === "ready" && state.fixtures.length > 0 && (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {state.fixtures.map((fixture) => (
            <li key={fixture.id}>
              <Link
                to={`/matches/${fixture.id}`}
                className="-mx-3 flex items-center justify-between gap-4 rounded-lg px-3 py-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {fixture.homeTeamName ?? fixture.homeTeamId}
                    <span className="mx-2 text-slate-400" aria-hidden="true">
                      vs
                    </span>
                    {fixture.awayTeamName ?? fixture.awayTeamId}
                  </p>
                  <time dateTime={fixture.kickoffUtc} className="text-sm text-slate-500 dark:text-slate-400">
                    {new Date(fixture.kickoffUtc).toUTCString()}
                  </time>
                </div>
                <FreshnessBadge freshness={fixture.freshness} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
