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

export type FreshnessColor = "GREEN" | "YELLOW" | "RED" | "GRAY";

export interface FreshnessEntry {
  domain: string;
  lastUpdated: string | null;
  status: Freshness;
  color: FreshnessColor;
}

export interface DataHealth {
  database: "reachable" | "unreachable";
  databaseError: string | null;
  productionFixtureCount: number;
  provider: string;
  providerConfigured: boolean;
  freshness: FreshnessEntry[];
}

export interface RateLimitStatus {
  limit: number | null;
  remaining: number | null;
  observedAt: string;
}

export interface LastRequestStatus {
  ok: boolean;
  reason?: string;
  at: string;
}

export interface ApiFootballHealth {
  status: "NOT_CONFIGURED" | "UNKNOWN" | "CONNECTED" | "ERROR";
  message: string | null;
  lastRequest: LastRequestStatus | null;
  rateLimit: RateLimitStatus | null;
}

export interface SchedulerJobStatus {
  name: string;
  cronExpression: string;
  nextRun: string | null;
}

export interface SchedulerHealth {
  status: "DISABLED" | "RUNNING";
  message: string | null;
  jobs: SchedulerJobStatus[];
}

export type IngestionRunStatus = "running" | "succeeded" | "failed" | "partial";

export interface IngestionRun {
  id: string;
  job_name: string;
  provider: string;
  status: IngestionRunStatus;
  records_processed: number;
  records_rejected: number;
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export type JobsSummary = Record<string, { lastRun: IngestionRun; lastSuccess: IngestionRun | null }>;

export interface AdminDataHealthCounts {
  productionFixtures: number;
  syntheticFixtures: number;
  currentPredictions: number;
}

// One walk-forward backtest run's aggregate result (see backend/src/jobs/runBacktest.ts).
export interface BacktestRunResult {
  runId: string | null;
  modelVersionId: string | null;
  evaluationId: string | null;
  sampleSize: number;
  skipped: number;
  accuracy: number | null;
  logLoss: number | null;
  brierScore: number | null;
}

// A row from model_evaluations, as written by a backtest run.
export interface BacktestEvaluation {
  id: string;
  model_version_id: string;
  competition_id: string | null;
  market: string;
  evaluation_window: string;
  accuracy: number | null;
  log_loss: number | null;
  brier_score: number | null;
  sample_size: number;
  created_at: string;
}
