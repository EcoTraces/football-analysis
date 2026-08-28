import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    vi.spyOn(api, "getBacktestResults").mockReturnValue(new Promise(() => {}));

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
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });

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
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });

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
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
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

  function mockBaselineDashboard() {
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
    vi.spyOn(api, "getAdminJobs").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getAdminDataHealth").mockResolvedValue({ data: { productionFixtures: 0, syntheticFixtures: 0, currentPredictions: 0 } });
  }

  it("renders past backtest runs with their metrics", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({
      data: [
        {
          id: "eval-1",
          model_version_id: "mv-1",
          modelName: "poisson-baseline",
          competition_id: null,
          market: "1x2",
          evaluation_window: "2024-01-01T00:00:00.000Z..2024-01-31T23:59:59.999Z",
          accuracy: 0.5,
          log_loss: 0.857,
          brier_score: 0.5,
          sample_size: 2,
          created_at: "2026-08-27T00:00:00Z"
        }
      ]
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("2024-01-01T00:00:00.000Z..2024-01-31T23:59:59.999Z")).toBeTruthy());
    expect(screen.getByText("poisson-baseline")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("0.857")).toBeTruthy();
    expect(screen.getByText("0.500")).toBeTruthy();
  });

  it("running a backtest sends the chosen date range as UTC day boundaries and refreshes results", async () => {
    mockBaselineDashboard();
    const getBacktestResults = vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const runBacktestSpy = vi.spyOn(api, "runBacktest").mockResolvedValue({
      data: {
        runId: "run-1",
        modelVersionId: "mv-1",
        evaluationId: "eval-1",
        sampleSize: 2,
        skipped: 0,
        accuracy: 0.5,
        logLoss: 0.857,
        brierScore: 0.4925
      }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Run backtest")).toBeTruthy());

    const fromInput = screen.getByLabelText("From") as HTMLInputElement;
    const toInput = screen.getByLabelText("To") as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2024-01-01" } });
    fireEvent.change(toInput, { target: { value: "2024-01-31" } });

    screen.getByText("Run backtest").click();

    await waitFor(() => expect(runBacktestSpy).toHaveBeenCalledTimes(1));
    // Defaults to the Poisson baseline when the model selector hasn't been touched.
    expect(runBacktestSpy).toHaveBeenCalledWith(
      "admin-token",
      "2024-01-01T00:00:00.000Z",
      "2024-01-31T23:59:59.999Z",
      undefined,
      "poisson-baseline"
    );
    expect(getBacktestResults).toHaveBeenCalledTimes(2); // initial load + post-run refresh
  });

  it("running a backtest with gradient boosting selected sends that model, not the default", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const runBacktestSpy = vi.spyOn(api, "runBacktest").mockResolvedValue({
      data: { runId: "run-1", modelVersionId: "mv-gb", evaluationId: "eval-1", sampleSize: 2, skipped: 0, accuracy: 0.5, logLoss: 0.6, brierScore: 0.4 }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Run backtest")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2024-01-31" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gradient-boosting" } });

    screen.getByText("Run backtest").click();

    await waitFor(() => expect(runBacktestSpy).toHaveBeenCalledTimes(1));
    expect(runBacktestSpy).toHaveBeenCalledWith(
      "admin-token",
      "2024-01-01T00:00:00.000Z",
      "2024-01-31T23:59:59.999Z",
      undefined,
      "gradient-boosting"
    );
  });

  it("training the gradient boosting model shows its in-sample accuracy and refreshes results", async () => {
    mockBaselineDashboard();
    const getBacktestResults = vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const trainSpy = vi.spyOn(api, "trainGradientBoosting").mockResolvedValue({
      data: { runId: "run-1", modelVersionId: "mv-gb", sampleSize: 25, skipped: 1, trainAccuracy: 0.8, classCounts: { home: 10, draw: 5, away: 10 } }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Train gradient boosting")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2024-01-31" } });

    screen.getByText("Train gradient boosting").click();

    await waitFor(() => expect(trainSpy).toHaveBeenCalledTimes(1));
    expect(trainSpy).toHaveBeenCalledWith("admin-token", "2024-01-01T00:00:00.000Z", "2024-01-31T23:59:59.999Z");
    await waitFor(() => expect(screen.getByText(/Trained on 25 fixtures/)).toBeTruthy());
    expect(screen.getByText(/80%/)).toBeTruthy();
    expect(getBacktestResults).toHaveBeenCalledTimes(2); // initial load + post-train refresh
  });

  it("shows an error message when training fails (e.g. too few qualifying fixtures in range)", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "trainGradientBoosting").mockRejectedValue(new api.ApiRequestError("Need at least 20 training rows, got 3.", 422));

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Train gradient boosting")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2024-01-31" } });

    screen.getByText("Train gradient boosting").click();

    await waitFor(() => expect(screen.getByText("Need at least 20 training rows, got 3.")).toBeTruthy());
  });

  it("shows an error message when the backtest run fails, without crashing the rest of the dashboard", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "runBacktest").mockRejectedValue(new api.ApiRequestError("No poisson-baseline model_version row exists yet.", 409));

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Run backtest")).toBeTruthy());

    const fromInput = screen.getByLabelText("From") as HTMLInputElement;
    const toInput = screen.getByLabelText("To") as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2024-01-01" } });
    fireEvent.change(toInput, { target: { value: "2024-01-31" } });

    screen.getByText("Run backtest").click();

    await waitFor(() => expect(screen.getByText("No poisson-baseline model_version row exists yet.")).toBeTruthy());
  });
});
