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

// Thin HTTP client for the Python ML service. Kept separate from route
// handlers so the timeout/error-mapping policy lives in exactly one place.
export class PredictionClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5000) {}

  async predictPoisson(payload: PoissonPredictionRequest): Promise<PoissonPredictionResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/predict/poisson`, {
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
}
