import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTodayFixtures } from "../lib/api";
import type { FixtureSummary } from "../lib/types";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; fixtures: FixtureSummary[] };

export function FixturesToday() {
  // This page only ever renders inside <RequireAuth>, which doesn't render
  // its children until status is "signed-in" — session.access_token is
  // guaranteed to exist by then.
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
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
  }, [session]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Today&apos;s fixtures</h1>
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        All times UTC. Only fixtures from a configured, verified data source are shown here — see the
        freshness badge on each match.
      </p>

      {state.status === "loading" && <p role="status">Loading fixtures…</p>}

      {state.status === "error" && (
        <p role="alert" className="text-red-600">
          Data unavailable: {state.message}
        </p>
      )}

      {state.status === "ready" && state.fixtures.length === 0 && (
        <p className="text-slate-600 dark:text-slate-400">
          No fixtures available for today. This platform ships with no football data provider configured by
          default — see Data_Sources.md to connect one.
        </p>
      )}

      {state.status === "ready" && state.fixtures.length > 0 && (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {state.fixtures.map((fixture) => (
            <li key={fixture.id} className="flex items-center justify-between py-3">
              <Link to={`/matches/${fixture.id}`} className="flex-1 hover:underline">
                <span className="font-medium">{fixture.homeTeamId}</span>
                <span className="mx-2 text-slate-400">vs</span>
                <span className="font-medium">{fixture.awayTeamId}</span>
              </Link>
              <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                <time dateTime={fixture.kickoffUtc}>{new Date(fixture.kickoffUtc).toUTCString()}</time>
                <FreshnessBadge freshness={fixture.freshness} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
