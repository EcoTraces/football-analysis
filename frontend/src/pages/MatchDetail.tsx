import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getMatch } from "../lib/api";
import type { MatchDetail as MatchDetailType } from "../lib/types";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { PredictionCard } from "../components/PredictionCard";
import { Skeleton } from "../components/Skeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; match: MatchDetailType };

// Every market after the primary 1x2 headline, in the order they appear
// inside the "More markets" disclosure. Kept as an explicit list (rather
// than "everything except 1x2") so a market PredictionCard has no data for
// simply renders nothing, instead of the list silently reordering itself.
const SECONDARY_MARKETS = [
  "btts",
  "over_under_2_5",
  "double_chance",
  "correct_score",
  "total_cards",
  "total_corners",
  "first_half_result",
  "second_half_result",
  "half_with_most_goals",
  "home_anytime_goalscorer",
  "away_anytime_goalscorer",
  "home_clean_sheet",
  "away_clean_sheet",
  "odd_even_goals",
  "draw_no_bet",
  "handicap",
  "home_team_total_goals",
  "away_team_total_goals",
  "home_wins_a_half",
  "away_wins_a_half",
  "btts_and_result",
  "result_and_total_goals"
];

export function MatchDetail() {
  const { id } = useParams<{ id: string }>();
  // This page only ever renders inside <RequireAuth> — session is
  // guaranteed to exist by the time we get here.
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!id || !session) return;
    let cancelled = false;
    setState({ status: "loading" });
    getMatch(id, session.access_token)
      .then((res) => {
        if (!cancelled) setState({ status: "ready", match: res.data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load match" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, session, reloadToken]);

  if (state.status === "loading") {
    return (
      <div role="status" aria-label="Loading match" className="space-y-6">
        <Skeleton className="h-8 w-2/3 max-w-md" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (state.status === "error") {
    return <ErrorState message={`Data unavailable: ${state.message}`} onRetry={() => setReloadToken((t) => t + 1)} />;
  }

  const { match } = state;
  const homeTeam = match.homeTeamName ?? match.home_team_id;
  const awayTeam = match.awayTeamName ?? match.away_team_id;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {homeTeam} <span className="font-normal text-slate-400">vs</span> {awayTeam}
        </h1>
        <FreshnessBadge freshness={match.freshness} />
      </div>

      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Kickoff <time dateTime={match.kickoff_utc}>{new Date(match.kickoff_utc).toUTCString()}</time> · Status:{" "}
        {match.status}
      </p>

      {!match.predictionsAvailable && (
        <EmptyState
          title="No prediction available for this match"
          description="Most likely because there isn't enough recent match data yet for one or both teams."
        />
      )}

      {match.predictionsAvailable && (
        <div className="space-y-6">
          <PredictionCard predictions={match.predictions} market="1x2" variant="primary" />

          <details className="group rounded-lg border border-slate-200 dark:border-slate-800">
            <summary className="cursor-pointer list-none rounded-lg px-4 py-3 font-medium hover:bg-slate-50 dark:hover:bg-slate-900">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
                  ▸
                </span>
                More markets &amp; analysis
              </span>
            </summary>
            <div className="grid gap-4 border-t border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-3 dark:border-slate-800">
              {/* Each card silently renders nothing (PredictionCard returns
                  null) when this fixture has no prediction for that
                  market — e.g. total_cards/total_corners need cards/corners
                  data synced, goalscorer markets need player_statistics. */}
              {SECONDARY_MARKETS.map((market) => (
                <PredictionCard key={market} predictions={match.predictions} market={market} />
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
