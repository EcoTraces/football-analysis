import type { AdminUserSummary, ApiEnvelope, FixtureSummary, MatchDetail, MeProfile, UserRole } from "./types";

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

export function getTodayFixtures(): Promise<ApiEnvelope<FixtureSummary[]>> {
  return request<ApiEnvelope<FixtureSummary[]>>("/fixtures/today");
}

export function getMatch(id: string): Promise<ApiEnvelope<MatchDetail>> {
  return request<ApiEnvelope<MatchDetail>>(`/matches/${id}`);
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
