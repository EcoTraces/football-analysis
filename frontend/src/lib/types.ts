export type Freshness = "LIVE" | "RECENT" | "STALE" | "UNAVAILABLE";

export interface FixtureSummary {
  id: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  freshness: Freshness;
  source: string;
  sourceTimestamp: string;
}

export interface PredictionFactor {
  direction: "positive" | "negative";
  label: string;
}

export interface PredictionView {
  market: string;
  selection: string;
  probability: number;
  confidence: "low" | "medium" | "high";
  dataQuality: "insufficient" | "limited" | "strong";
  riskClassification: "low" | "moderate" | "high" | null;
  factors: PredictionFactor[];
  modelVersionId: string;
  generatedAt: string;
  freshness: Freshness;
}

export interface MatchDetail {
  id: string;
  competition_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_utc: string;
  status: string;
  home_score: number | null;
  away_score: number | null;
  importance_tags: string[];
  freshness: Freshness;
  predictions: PredictionView[];
  predictionsAvailable: boolean;
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export type UserRole = "user" | "admin";

export interface MeProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  createdAt: string;
}

export interface AdminUserSummary {
  id: string;
  email: string | null;
  role: UserRole;
  displayName: string | null;
  createdAt: string;
}
