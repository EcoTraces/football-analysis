import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTop20 } from "../lib/api";
import type { EnsemblePredictionRow } from "../lib/types";
import { RiskTierBadge } from "../components/RiskTierBadge";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: EnsemblePredictionRow[] };

const SELECTION_LABEL: Record<string, string> = { home: "Home", draw: "Draw", away: "Away" };

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function RowSkeleton() {
  return (
    <tr className="border-b border-slate-100 dark:border-slate-900">
      <td className="py-3 pr-4">
        <Skeleton className="h-4 w-40" />
      </td>
      <td className="py-3 pr-4">
        <Skeleton className="h-4 w-16" />
      </td>
      <td className="py-3 pr-4">
        <Skeleton className="h-4 w-12" />
      </td>
      <td className="py-3 pr-4">
        <Skeleton className="h-4 w-12" />
      </td>
      <td className="py-3">
        <Skeleton className="h-5 w-16" />
      </td>
    </tr>
  );
}

export function Top20() {
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading" });
    getTop20(session.access_token)
      .then((res) => {
        if (!cancelled) setState({ status: "ready", rows: res.data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load Top 20" });
      });
    return () => {
      cancelled = true;
    };
  }, [session, reloadToken]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Top 20</h1>
      <p className="mb-6 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        The highest-scoring opportunity per match, ranked by the ensemble model&apos;s 0-100 selection score. These
        are statistical estimates, not guarantees — see each row&apos;s risk tier and data quality before acting on
        it.
      </p>

      {state.status === "loading" && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" aria-label="Loading Top 20">
            <tbody>
              <RowSkeleton />
              <RowSkeleton />
              <RowSkeleton />
            </tbody>
          </table>
        </div>
      )}

      {state.status === "error" && (
        <ErrorState message={`Data unavailable: ${state.message}`} onRetry={() => setReloadToken((t) => t + 1)} />
      )}

      {state.status === "ready" && state.rows.length === 0 && (
        <EmptyState
          title="No high-confidence opportunities today"
          description="Either no competitions are allowlisted for screening yet, or nothing currently clears the configured score/risk thresholds. This is expected behavior, not an error — the engine never forces a pick."
        />
      )}

      {state.status === "ready" && state.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="py-2 pr-4 font-medium">#</th>
                <th className="py-2 pr-4 font-medium">Match</th>
                <th className="py-2 pr-4 font-medium">Pick</th>
                <th className="py-2 pr-4 font-medium">Model %</th>
                <th className="py-2 pr-4 font-medium">Edge / EV</th>
                <th className="py-2 pr-4 font-medium">Score</th>
                <th className="py-2 pr-4 font-medium">Consensus</th>
                <th className="py-2 font-medium">Risk</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row, index) => (
                <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                  <td className="py-3 pr-4 text-slate-500 dark:text-slate-400">{index + 1}</td>
                  <td className="py-3 pr-4">
                    <Link to={`/matches/${row.fixtureId}`} className="hover:underline">
                      <span className="font-medium">
                        {row.homeTeamName ?? "Home"}
                        <span className="mx-1 text-slate-400" aria-hidden="true">
                          v
                        </span>
                        {row.awayTeamName ?? "Away"}
                      </span>
                      {row.competitionName && <span className="block text-xs text-slate-500 dark:text-slate-400">{row.competitionName}</span>}
                    </Link>
                  </td>
                  <td className="py-3 pr-4">{SELECTION_LABEL[row.selection] ?? row.selection}</td>
                  <td className="py-3 pr-4 tabular-nums">{formatPercent(row.combinedProbability)}</td>
                  <td className="py-3 pr-4 tabular-nums">
                    {row.edgePct === null || row.ev === null ? (
                      <span className="text-slate-500 dark:text-slate-400">Odds unavailable</span>
                    ) : (
                      <span className={row.edgePct >= 0 ? "text-pitch-700 dark:text-pitch-300" : "text-red-600 dark:text-red-400"}>
                        {row.edgePct >= 0 ? "+" : ""}
                        {row.edgePct.toFixed(1)}% edge
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 tabular-nums">{row.selectionScore.toFixed(0)}</td>
                  <td className="py-3 pr-4 capitalize">{row.consensusLevel}</td>
                  <td className="py-3">
                    <RiskTierBadge tier={row.riskTier} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
