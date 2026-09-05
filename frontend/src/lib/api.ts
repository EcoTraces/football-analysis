import type {
  AccumulatorRecommendation,
  AccumulatorTarget,
  AdminAuditLogEntry,
  AdminDataHealthCounts,
  AdminUserSummary,
  ApiEnvelope,
  ApiFootballHealth,
  BacktestableModel,
  BacktestEvaluation,
  BacktestRunResult,
  Competition,
  CompetitionAllowlistEntry,
  CompetitionRhoRow,
  DataHealth,
  DixonColesRhoFitResult,
  EnsemblePredictionRow,
  EnsembleWeights,
  FixtureSummary,
  GradientBoostingTrainResult,
  IngestionRun,
  JobsSummary,
  LeagueCalibrationRow,
  MatchDetail,
  MeProfile,
  RhoStatus,
  SchedulerHealth,
  ScreeningConfig,
  UserRole
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api";

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiRequestError(body?.error?.message ?? `Request failed with status ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

function authedRequest<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }
  });
}

// Requires a signed-in session — the backend rejects these without a
// bearer token (see README.md → "User access control").
export function getTodayFixtures(accessToken: string): Promise<ApiEnvelope<FixtureSummary[]>> {
  return authedRequest<ApiEnvelope<FixtureSummary[]>>("/fixtures/today", accessToken);
}

export function getMatch(id: string, accessToken: string): Promise<ApiEnvelope<MatchDetail>> {
  return authedRequest<ApiEnvelope<MatchDetail>>(`/matches/${id}`, accessToken);
}

/** The current session's own profile (role, display name) — also auto-provisions the profile row on first call. */
export function getMe(accessToken: string): Promise<ApiEnvelope<MeProfile>> {
  return authedRequest<ApiEnvelope<MeProfile>>("/me", accessToken);
}

/** Admin-only: every account, joined with its role. */
export function listAdminUsers(accessToken: string): Promise<ApiEnvelope<AdminUserSummary[]>> {
  return authedRequest<ApiEnvelope<AdminUserSummary[]>>("/admin/users", accessToken);
}

/** Admin-only: promote/demote an account. The backend refuses to demote the last remaining admin (409). */
export function setUserRole(
  accessToken: string,
  userId: string,
  role: UserRole
): Promise<ApiEnvelope<{ id: string; role: UserRole }>> {
  return authedRequest<ApiEnvelope<{ id: string; role: UserRole }>>(`/admin/users/${userId}/role`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role })
  });
}

// --- Health (public — no auth required, see backend/src/routes/health.ts) ---

export function getDataHealth(): Promise<DataHealth> {
  return request<DataHealth>("/health/data");
}

export function getApiFootballHealth(): Promise<ApiFootballHealth> {
  return request<ApiFootballHealth>("/health/api-football");
}

export function getSchedulerHealth(): Promise<SchedulerHealth> {
  return request<SchedulerHealth>("/health/scheduler");
}

// --- Admin: job history, fixture counts, and manual sync triggers ---

export function getAdminJobs(accessToken: string, limit = 20): Promise<ApiEnvelope<IngestionRun[]>> {
  return authedRequest<ApiEnvelope<IngestionRun[]>>(`/admin/jobs?limit=${limit}`, accessToken);
}

export function getAdminJobsSummary(accessToken: string): Promise<ApiEnvelope<JobsSummary>> {
  return authedRequest<ApiEnvelope<JobsSummary>>("/admin/jobs/summary", accessToken);
}

export function getAdminDataHealth(accessToken: string): Promise<ApiEnvelope<AdminDataHealthCounts>> {
  return authedRequest<ApiEnvelope<AdminDataHealthCounts>>("/admin/data-health", accessToken);
}

export function getAdminAuditLog(accessToken: string, limit = 20): Promise<ApiEnvelope<AdminAuditLogEntry[]>> {
  return authedRequest<ApiEnvelope<AdminAuditLogEntry[]>>(`/admin/audit-log?limit=${limit}`, accessToken);
}

export interface SyncAction {
  key: string;
  label: string;
  /** Path including any query string — sync jobs use the backend's own defaults (see admin.ts). */
  path: string;
}

// Every job this platform actually runs, in the order the scheduler runs
// them (fixtures before anything that reads fixtures — see scheduler.ts).
export const SYNC_ACTIONS: SyncAction[] = [
  { key: "sync_fixtures", label: "Fixtures", path: "/admin/sync" },
  { key: "sync_team_statistics", label: "Team statistics", path: "/admin/team-statistics/sync" },
  { key: "sync_player_statistics", label: "Player statistics", path: "/admin/player-statistics/sync" },
  { key: "sync_injuries", label: "Injuries", path: "/admin/injuries/sync" },
  { key: "sync_standings", label: "Standings", path: "/admin/standings/sync" },
  { key: "sync_lineups", label: "Lineups", path: "/admin/lineups/sync" },
  { key: "sync_odds", label: "Odds", path: "/admin/odds/sync" },
  { key: "sync_fixture_statistics", label: "Fixture statistics (corners)", path: "/admin/fixture-statistics/sync" },
  { key: "calibrate_leagues", label: "League calibration", path: "/admin/league-calibration/run" },
  { key: "predictions", label: "Predictions", path: "/admin/predictions/run" },
  { key: "compute_elo_ratings", label: "Elo ratings", path: "/admin/elo/recompute" },
  { key: "predictions_ensemble", label: "Ensemble predictions", path: "/admin/predictions/ensemble/run" },
  { key: "build_accumulators", label: "Accumulators", path: "/admin/accumulators/build" }
];

/** Triggers one sync/prediction job with the backend's own defaults. Response shape varies by job — see API.md. */
export function triggerSync(accessToken: string, path: string): Promise<ApiEnvelope<Record<string, unknown>>> {
  return authedRequest<ApiEnvelope<Record<string, unknown>>>(path, accessToken, { method: "POST" });
}

// --- Admin: backtesting ---
// Separate from SYNC_ACTIONS/triggerSync above — a backtest run needs an
// admin-chosen date range, not a fixed default window, so it gets its own
// request builder rather than a fire-with-defaults SyncAction entry.

/**
 * Runs a walk-forward 1x2 backtest over [from, to] (ISO date/timestamp
 * strings) and writes one model_evaluations row. `model` picks which
 * registered model gets scored (defaults to the Poisson baseline) — running
 * this twice with a different model over the same range is how the two
 * become comparable.
 */
export function runBacktest(
  accessToken: string,
  from: string,
  to: string,
  competitionId?: string,
  model?: BacktestableModel
): Promise<ApiEnvelope<BacktestRunResult>> {
  const params = new URLSearchParams({ from, to });
  if (competitionId) params.set("competitionId", competitionId);
  if (model) params.set("model", model);
  return authedRequest<ApiEnvelope<BacktestRunResult>>(`/admin/backtest/run?${params.toString()}`, accessToken, { method: "POST" });
}

/** Past backtest runs (any model), newest first. */
export function getBacktestResults(accessToken: string, limit = 20): Promise<ApiEnvelope<BacktestEvaluation[]>> {
  return authedRequest<ApiEnvelope<BacktestEvaluation[]>>(`/admin/backtest/results?limit=${limit}`, accessToken);
}

/**
 * Trains the gradient-boosting model on point-in-time features built from
 * real, finished fixtures in [from, to]. A rare, explicit action — never
 * scheduled. Throws (via ApiRequestError) with ml-service's own validation
 * message when the range doesn't have enough qualifying fixtures.
 */
export function trainGradientBoosting(
  accessToken: string,
  from: string,
  to: string,
  competitionId?: string
): Promise<ApiEnvelope<GradientBoostingTrainResult>> {
  const params = new URLSearchParams({ from, to });
  if (competitionId) params.set("competitionId", competitionId);
  return authedRequest<ApiEnvelope<GradientBoostingTrainResult>>(`/admin/model/gradient-boosting/train?${params.toString()}`, accessToken, {
    method: "POST"
  });
}

/**
 * Fits the Dixon-Coles rho parameter from point-in-time features built
 * from real, finished fixtures in [from, to], and updates the
 * poisson-baseline model to use it for every prediction after this call
 * (see ML_Model.md's "Rho fitting" section). A rare, explicit action —
 * never scheduled. Throws (via ApiRequestError) with ml-service's own
 * validation message when the range doesn't have enough matches finishing
 * 0-0, 1-0, 0-1, or 1-1 — those are the only scorelines rho fitting can
 * learn anything from.
 */
export function fitDixonColesRho(
  accessToken: string,
  from: string,
  to: string,
  competitionId?: string
): Promise<ApiEnvelope<DixonColesRhoFitResult>> {
  const params = new URLSearchParams({ from, to });
  if (competitionId) params.set("competitionId", competitionId);
  return authedRequest<ApiEnvelope<DixonColesRhoFitResult>>(`/admin/model/poisson/fit-rho?${params.toString()}`, accessToken, {
    method: "POST"
  });
}

/** Whether a fitted rho is currently in effect for /predict/poisson, or predictions are still using the fixed default. */
export function getRhoStatus(accessToken: string): Promise<ApiEnvelope<RhoStatus>> {
  return authedRequest<ApiEnvelope<RhoStatus>>("/admin/model/poisson/rho-status", accessToken);
}

/** Every competition's current real per-league goal averages (see ML_Model.md's "League-specific calibration" section). */
export function getLeagueCalibrationResults(accessToken: string): Promise<ApiEnvelope<LeagueCalibrationRow[]>> {
  return authedRequest<ApiEnvelope<LeagueCalibrationRow[]>>("/admin/league-calibration/results", accessToken);
}

/** Every competition's current per-competition Dixon-Coles rho fit (see ML_Model.md's "Rho fitting" section). */
export function getCompetitionRhoResults(accessToken: string): Promise<ApiEnvelope<CompetitionRhoRow[]>> {
  return authedRequest<ApiEnvelope<CompetitionRhoRow[]>>("/admin/model/poisson/competition-rho", accessToken);
}

/** Every real (non-synthetic) competition — used for the public competitions listing and the admin allowlist toggle table. */
export function getLeagues(accessToken: string): Promise<ApiEnvelope<Competition[]>> {
  return authedRequest<ApiEnvelope<Competition[]>>("/leagues", accessToken);
}

// --- AI Football Analyst: admin config (Phase 1) ---

export function getEnsembleWeights(accessToken: string): Promise<ApiEnvelope<EnsembleWeights>> {
  return authedRequest<ApiEnvelope<EnsembleWeights>>("/admin/config/ensemble-weights", accessToken);
}

export function setEnsembleWeights(accessToken: string, weights: Omit<EnsembleWeights, "isDefault">): Promise<ApiEnvelope<EnsembleWeights>> {
  return authedRequest<ApiEnvelope<EnsembleWeights>>("/admin/config/ensemble-weights", accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(weights)
  });
}

export function getScreeningConfig(accessToken: string): Promise<ApiEnvelope<ScreeningConfig>> {
  return authedRequest<ApiEnvelope<ScreeningConfig>>("/admin/config/screening", accessToken);
}

export function setScreeningConfig(accessToken: string, config: Omit<ScreeningConfig, "isDefault">): Promise<ApiEnvelope<ScreeningConfig>> {
  return authedRequest<ApiEnvelope<ScreeningConfig>>("/admin/config/screening", accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
}

export function getAccumulatorTargets(accessToken: string): Promise<ApiEnvelope<AccumulatorTarget[]>> {
  return authedRequest<ApiEnvelope<AccumulatorTarget[]>>("/admin/config/accumulator-targets", accessToken);
}

export function setAccumulatorTarget(
  accessToken: string,
  legs: number,
  minSelectionScore: number,
  enabled: boolean
): Promise<ApiEnvelope<AccumulatorTarget[]>> {
  return authedRequest<ApiEnvelope<AccumulatorTarget[]>>(`/admin/config/accumulator-targets/${legs}`, accessToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minSelectionScore, enabled })
  });
}

export function getCompetitionAllowlist(accessToken: string): Promise<ApiEnvelope<CompetitionAllowlistEntry[]>> {
  return authedRequest<ApiEnvelope<CompetitionAllowlistEntry[]>>("/admin/config/competition-allowlist", accessToken);
}

export function setCompetitionAllowlistEntry(
  accessToken: string,
  competitionId: string,
  enabled: boolean
): Promise<ApiEnvelope<CompetitionAllowlistEntry[]>> {
  return authedRequest<ApiEnvelope<CompetitionAllowlistEntry[]>>(`/admin/config/competition-allowlist/${competitionId}`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
}

// --- AI Football Analyst: screening (Top 20 / Matches to Avoid / Accumulators) ---

export function getTop20(accessToken: string): Promise<ApiEnvelope<EnsemblePredictionRow[]>> {
  return authedRequest<ApiEnvelope<EnsemblePredictionRow[]>>("/top20", accessToken);
}

export function getMatchesToAvoid(accessToken: string): Promise<ApiEnvelope<EnsemblePredictionRow[]>> {
  return authedRequest<ApiEnvelope<EnsemblePredictionRow[]>>("/matches-to-avoid", accessToken);
}

export function getAccumulators(accessToken: string, legs?: number): Promise<ApiEnvelope<AccumulatorRecommendation[]>> {
  const query = legs ? `?legs=${legs}` : "";
  return authedRequest<ApiEnvelope<AccumulatorRecommendation[]>>(`/accumulators${query}`, accessToken);
}
