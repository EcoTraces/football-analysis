export interface TeamStrengthInput {
  matchesPlayed: number;
  goalsScoredAvg: number;
  goalsConcededAvg: number;
}

export interface PlayerCandidateInput {
  name: string;
  goalsScored: number;
  matchesPlayed: number;
}

export interface PoissonPredictionRequest {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
  leagueAvgHomeGoals: number;
  leagueAvgAwayGoals: number;
  // Optional — the ml-service only predicts total_cards/total_corners when
  // both of a pair are present (see main.py). Omitted, not sent as 0, when
  // this team's team_statistics row doesn't have the underlying data yet.
  homeTeamAvgYellowCards?: number;
  awayTeamAvgYellowCards?: number;
  homeTeamAvgCorners?: number;
  awayTeamAvgCorners?: number;
  // Optional, per side independently (unlike the cards/corners pairs above)
  // — the ml-service only builds a side's anytime-goalscorer market when
  // its own list is present, regardless of what the other side sent.
  homeTeamPlayers?: PlayerCandidateInput[];
  awayTeamPlayers?: PlayerCandidateInput[];
}

export interface MarketProbability {
  market: string;
  selection: string;
  probability: number;
  factors: { direction: "positive" | "negative"; label: string }[];
}

export interface PoissonPredictionResponse {
  modelName: string;
  modelVersion: string;
  dataQuality: "insufficient" | "limited" | "strong";
  predictions: MarketProbability[];
}

// Second model on the wishlist (Task.md) — 1x2 only, see
// ml-service/app/models/gradient_boosting.py. Reuses TeamStrengthInput; no
// league-average/cards/corners/player fields, since this model doesn't use
// them.
export interface GradientBoostingPredictRequest {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
}

export type OneXTwoOutcome = "home" | "draw" | "away";

export interface GradientBoostingTrainingRow {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
  outcome: OneXTwoOutcome;
}

export interface GradientBoostingTrainRequest {
  rows: GradientBoostingTrainingRow[];
}

export interface GradientBoostingTrainResult {
  sampleSize: number;
  // In-sample only — see gradient_boosting.py's TrainingResult docstring.
  // Never present this as a generalization/held-out metric.
  trainAccuracy: number;
  classCounts: Record<string, number>;
}

// Thin HTTP client for the Python ML service. Kept separate from route
// handlers so the timeout/error-mapping policy lives in exactly one place.
export class PredictionClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5000) {}

  async predictPoisson(payload: PoissonPredictionRequest): Promise<PoissonPredictionResponse | null> {
    return this.predictOrNull("/predict/poisson", payload);
  }

  // Same null-on-any-failure contract as predictPoisson, including the
  // ml-service's 409 "not trained yet" response — the caller (backtest
  // scoring, live predictions) treats "no result" as "skip this one",
  // never fabricates a fallback probability.
  async predictGradientBoosting(payload: GradientBoostingPredictRequest): Promise<PoissonPredictionResponse | null> {
    return this.predictOrNull("/predict/gradient_boosting", payload);
  }

  private async predictOrNull(path: string, payload: unknown): Promise<PoissonPredictionResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) return null;
      return (await res.json()) as PoissonPredictionResponse;
    } catch {
      // Network error, timeout, or malformed response — caller treats a
      // null result as "prediction unavailable", never fabricates one.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unlike predictions, a training failure is rare and actionable (e.g. too
  // few rows, or a single-outcome dataset — see gradient_boosting.py) — so
  // this throws with the ml-service's own detail message rather than
  // swallowing to null, letting the admin route surface exactly why
  // training didn't happen.
  async trainGradientBoosting(payload: GradientBoostingTrainRequest): Promise<GradientBoostingTrainResult> {
    const controller = new AbortController();
    // Training a few hundred rows of gradient boosting is more expensive
    // than a single prediction — give it more room before giving up.
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs * 6);
    try {
      const res = await fetch(`${this.baseUrl}/train/gradient_boosting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(body?.detail ?? `Training request failed with status ${res.status}`);
      }
      return (await res.json()) as GradientBoostingTrainResult;
    } finally {
      clearTimeout(timeout);
    }
  }
}
