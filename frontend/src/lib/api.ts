import type { ApiEnvelope, FixtureSummary, MatchDetail } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080/api";

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiRequestError(body?.error?.message ?? `Request failed with status ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export function getTodayFixtures(): Promise<ApiEnvelope<FixtureSummary[]>> {
  return request<ApiEnvelope<FixtureSummary[]>>("/fixtures/today");
}

export function getMatch(id: string): Promise<ApiEnvelope<MatchDetail>> {
  return request<ApiEnvelope<MatchDetail>>(`/matches/${id}`);
}
