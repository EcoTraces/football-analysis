import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getMatch } from "../lib/api";
import type { MatchDetail as MatchDetailType } from "../lib/types";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { PredictionCard } from "../components/PredictionCard";
import { useAuth } from "../lib/auth";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; match: MatchDetailType };

export function MatchDetail() {
  const { id } = useParams<{ id: string }>();
  // This page only ever renders inside <RequireAuth> — session is
  // guaranteed to exist by the time we get here.
  const { session } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!id || !session) return;
    let cancelled = false;
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
  }, [id, session]);

  if (state.status === "loading") return <p role="status">Loading match…</p>;
  if (state.status === "error") return <p role="alert" className="text-red-600">Data unavailable: {state.message}</p>;

  const { match } = state;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-bold">
          {match.home_team_id} vs {match.away_team_id}
        </h1>
        <FreshnessBadge freshness={match.freshness} />
      </div>

      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Kickoff <time dateTime={match.kickoff_utc}>{new Date(match.kickoff_utc).toUTCString()}</time> · Status:{" "}
        {match.status}
      </p>

      {!match.predictionsAvailable && (
        <p className="rounded-md border border-slate-200 p-4 text-slate-600 dark:border-slate-800 dark:text-slate-400">
          Data unavailable: no prediction has been generated for this match yet, most likely because there
          isn&apos;t enough recent match data for one or both teams.
        </p>
      )}

      {match.predictionsAvailable && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <PredictionCard predictions={match.predictions} market="1x2" />
          <PredictionCard predictions={match.predictions} market="btts" />
          <PredictionCard predictions={match.predictions} market="over_under_2_5" />
          <PredictionCard predictions={match.predictions} market="double_chance" />
          <PredictionCard predictions={match.predictions} market="correct_score" />
          {/* Both render nothing (PredictionCard returns null) when a fixture
              has no total_cards/total_corners prediction — these two markets
              are only produced once both teams have cards/corners data
              synced, unlike the always-present goals-based markets above. */}
          <PredictionCard predictions={match.predictions} market="total_cards" />
          <PredictionCard predictions={match.predictions} market="total_corners" />
          <PredictionCard predictions={match.predictions} market="first_half_result" />
          <PredictionCard predictions={match.predictions} market="second_half_result" />
          <PredictionCard predictions={match.predictions} market="half_with_most_goals" />
          {/* Independent per-player probabilities, not mutually exclusive —
              see player_market.py. Only appear once player_statistics has
              been synced for that team's season. */}
          <PredictionCard predictions={match.predictions} market="home_anytime_goalscorer" />
          <PredictionCard predictions={match.predictions} market="away_anytime_goalscorer" />
        </div>
      )}
    </div>
  );
}
