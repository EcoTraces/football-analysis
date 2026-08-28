import type {
  AdminDataHealthCounts,
  AdminUserSummary,
  ApiEnvelope,
  ApiFootballHealth,
  DataHealth,
  FixtureSummary,
  IngestionRun,
  JobsSummary,
  MatchDetail,
  MeProfile,
  SchedulerHealth,
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
  { key: "sync_injuries", label: "Injuries", path: "/admin/injuries/sync" },
  { key: "sync_standings", label: "Standings", path: "/admin/standings/sync" },
  { key: "sync_lineups", label: "Lineups", path: "/admin/lineups/sync" },
  { key: "sync_odds", label: "Odds", path: "/admin/odds/sync" },
  { key: "sync_fixture_statistics", label: "Fixture statistics (corners)", path: "/admin/fixture-statistics/sync" },
  { key: "predictions", label: "Predictions", path: "/admin/predictions/run" }
];

/** Triggers one sync/prediction job with the backend's own defaults. Response shape varies by job — see API.md. */
export function triggerSync(accessToken: string, path: string): Promise<ApiEnvelope<Record<string, unknown>>> {
  return authedRequest<ApiEnvelope<Record<string, unknown>>>(path, accessToken, { method: "POST" });
}
