import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthContext, type AuthContextValue } from "../../../lib/auth";
import { AdminDashboard } from "../AdminDashboard";
import * as api from "../../../lib/api";

function authValue(): AuthContextValue {
  return {
    status: "signed-in",
    session: { access_token: "admin-token" } as AuthContextValue["session"],
    profile: { id: "admin-1", email: "admin@example.com", displayName: null, role: "admin", createdAt: "2026-01-01T00:00:00Z" },
    signInWithPassword: async () => ({ error: null }),
    signUp: async () => ({ error: null, emailConfirmationRequired: false }),
    signOut: async () => {}
  };
}

function renderDashboard() {
  return render(
    <AuthContext.Provider value={authValue()}>
      <AdminDashboard />
    </AuthContext.Provider>
  );
}

describe("AdminDashboard", () => {
  it("shows a loading state before any data resolves", () => {
    vi.spyOn(api, "getDataHealth").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getApiFootballHealth").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getSchedulerHealth").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getAdminJobsSummary").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getAdminJobs").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getAdminDataHealth").mockReturnValue(new Promise(() => {}));

    renderDashboard();

    expect(screen.getByText(/loading dashboard/i)).toBeTruthy();
  });

  it("renders provider, scheduler, and database status once loaded", async () => {
    vi.spyOn(api, "getDataHealth").mockResolvedValue({
      database: "reachable",
      databaseError: null,
      productionFixtureCount: 5,
      provider: "api-football",
      providerConfigured: true,
      freshness: [{ domain: "fixtures", lastUpdated: "2026-08-27T00:00:00Z", status: "LIVE", color: "GREEN" }]
    });
    vi.spyOn(api, "getApiFootballHealth").mockResolvedValue({
      status: "CONNECTED",
      message: null,
      lastRequest: { ok: true, at: "2026-08-27T00:00:00Z" },
      rateLimit: { limit: 100, remaining: 42, observedAt: "2026-08-27T00:00:00Z" }
    });
    vi.spyOn(api, "getSchedulerHealth").mockResolvedValue({
      status: "RUNNING",
      message: null,
      jobs: [{ name: "predictions", cronExpression: "15 3 * * *", nextRun: "2026-08-28T03:15:00Z" }]
    });
    vi.spyOn(api, "getAdminJobsSummary").mockResolvedValue({ data: {} });
    vi.spyOn(api, "getAdminJobs").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getAdminDataHealth").mockResolvedValue({ data: { productionFixtures: 5, syntheticFixtures: 0, currentPredictions: 2 } });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeTruthy());
    expect(screen.getByText("RUNNING")).toBeTruthy();
    expect(screen.getByText("reachable")).toBeTruthy();
    expect(screen.getByText(/42 \/ 100/)).toBeTruthy();
    expect(screen.getByText("fixtures")).toBeTruthy();
  });

  it("shows an independent error for one section without blocking the others", async () => {
    vi.spyOn(api, "getDataHealth").mockResolvedValue({
      database: "reachable",
      databaseError: null,
      productionFixtureCount: 0,
      provider: "null",
      providerConfigured: false,
      freshness: []
    });
    vi.spyOn(api, "getApiFootballHealth").mockRejectedValue(new api.ApiRequestError("boom", 500));
    vi.spyOn(api, "getSchedulerHealth").mockResolvedValue({ status: "DISABLED", message: "off", jobs: [] });
    vi.spyOn(api, "getAdminJobsSummary").mockResolvedValue({ data: {} });
    vi.spyOn(api, "getAdminJobs").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getAdminDataHealth").mockResolvedValue({ data: { productionFixtures: 0, syntheticFixtures: 0, currentPredictions: 0 } });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    // The scheduler card still rendered successfully alongside the provider error.
    expect(screen.getByText("DISABLED")).toBeTruthy();
  });

  it("triggering a sync job shows its result and refreshes job history", async () => {
    vi.spyOn(api, "getDataHealth").mockResolvedValue({
      database: "reachable",
      databaseError: null,
      productionFixtureCount: 0,
      provider: "null",
      providerConfigured: false,
      freshness: []
    });
    vi.spyOn(api, "getApiFootballHealth").mockResolvedValue({ status: "NOT_CONFIGURED", message: null, lastRequest: null, rateLimit: null });
    vi.spyOn(api, "getSchedulerHealth").mockResolvedValue({ status: "DISABLED", message: null, jobs: [] });
    vi.spyOn(api, "getAdminJobsSummary").mockResolvedValue({ data: {} });
    const getAdminJobs = vi.spyOn(api, "getAdminJobs").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getAdminDataHealth").mockResolvedValue({ data: { productionFixtures: 0, syntheticFixtures: 0, currentPredictions: 0 } });
    const triggerSync = vi.spyOn(api, "triggerSync").mockResolvedValue({
      data: { runId: "run-1", fixturesProcessed: 3, fixturesRejected: 0 }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Sync Fixtures")).toBeTruthy());

    screen.getByText("Sync Fixtures").click();

    await waitFor(() => expect(screen.getByText("fixturesProcessed")).toBeTruthy());
    expect(triggerSync).toHaveBeenCalledWith("admin-token", "/admin/sync");
    // runId is filtered out of the displayed result.
    expect(screen.queryByText("runId")).toBeNull();
    expect(getAdminJobs).toHaveBeenCalledTimes(2); // initial load + post-trigger refresh
  });
});
