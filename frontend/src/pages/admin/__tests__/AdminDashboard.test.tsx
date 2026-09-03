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
    vi.spyOn(api, "getRhoStatus").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getLeagueCalibrationResults").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getCompetitionRhoResults").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getEnsembleWeights").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getScreeningConfig").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getAccumulatorTargets").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getCompetitionAllowlist").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getLeagues").mockReturnValue(new Promise(() => {}));

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
    vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: null, defaultRho: -0.1 } });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionRhoResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getEnsembleWeights").mockResolvedValue({
      data: { elo: 0.2667, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667, isDefault: true }
    });
    vi.spyOn(api, "getScreeningConfig").mockResolvedValue({
      data: {
        scoreWeights: { ensembleConfidence: 0.4, ev: 0.3, consensus: 0.2, dataQuality: 0.1 },
        riskThresholds: { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 },
        isDefault: true
      }
    });
    vi.spyOn(api, "getAccumulatorTargets").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionAllowlist").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagues").mockResolvedValue({ data: [] });

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
    vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: null, defaultRho: -0.1 } });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionRhoResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getEnsembleWeights").mockResolvedValue({
      data: { elo: 0.2667, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667, isDefault: true }
    });
    vi.spyOn(api, "getScreeningConfig").mockResolvedValue({
      data: {
        scoreWeights: { ensembleConfidence: 0.4, ev: 0.3, consensus: 0.2, dataQuality: 0.1 },
        riskThresholds: { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 },
        isDefault: true
      }
    });
    vi.spyOn(api, "getAccumulatorTargets").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionAllowlist").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagues").mockResolvedValue({ data: [] });

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
    vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: null, defaultRho: -0.1 } });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionRhoResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getEnsembleWeights").mockResolvedValue({
      data: { elo: 0.2667, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667, isDefault: true }
    });
    vi.spyOn(api, "getScreeningConfig").mockResolvedValue({
      data: {
        scoreWeights: { ensembleConfidence: 0.4, ev: 0.3, consensus: 0.2, dataQuality: 0.1 },
        riskThresholds: { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 },
        isDefault: true
      }
    });
    vi.spyOn(api, "getAccumulatorTargets").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionAllowlist").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagues").mockResolvedValue({ data: [] });
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
    vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: null, defaultRho: -0.1 } });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionRhoResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getEnsembleWeights").mockResolvedValue({
      data: { elo: 0.2667, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667, isDefault: true }
    });
    vi.spyOn(api, "getScreeningConfig").mockResolvedValue({
      data: {
        scoreWeights: { ensembleConfidence: 0.4, ev: 0.3, consensus: 0.2, dataQuality: 0.1 },
        riskThresholds: { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 },
        isDefault: true
      }
    });
    vi.spyOn(api, "getAccumulatorTargets").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionAllowlist").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagues").mockResolvedValue({ data: [] });
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

  it("shows the current fitted rho when one is in effect, instead of the fixed default", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: -0.2837, defaultRho: -0.1 } });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("-0.2837")).toBeTruthy());
  });

  it("shows the fixed default label when rho has never been fit", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: null, defaultRho: -0.1 } });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });

    renderDashboard();

    await waitFor(() => expect(screen.getByText(/-0.1 \(fixed default, never fit\)/)).toBeTruthy());
  });

  it("fitting rho shows the fitted value and refreshes the rho status", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const getRhoStatus = vi.spyOn(api, "getRhoStatus").mockResolvedValue({ data: { fittedRho: null, defaultRho: -0.1 } });
    const fitRhoSpy = vi.spyOn(api, "fitDixonColesRho").mockResolvedValue({
      data: {
        runId: "run-1",
        modelVersionId: "mv-poisson",
        competitionId: null,
        sampleSize: 40,
        skipped: 2,
        informativeMatches: 40,
        fittedRho: -0.31,
        logLikelihoodAtFittedRho: -10,
        logLikelihoodAtDefaultRho: -20,
        defaultRho: -0.1
      }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Fit Dixon-Coles rho (global)")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2024-01-31" } });

    screen.getByText("Fit Dixon-Coles rho (global)").click();

    await waitFor(() => expect(fitRhoSpy).toHaveBeenCalledTimes(1));
    expect(fitRhoSpy).toHaveBeenCalledWith("admin-token", "2024-01-01T00:00:00.000Z", "2024-01-31T23:59:59.999Z", undefined);
    await waitFor(() => expect(screen.getByText(/Fitted rho = -0.3100 from 40 matches/)).toBeTruthy());
    expect(screen.getByText(/now in effect for every poisson-baseline prediction/)).toBeTruthy();
    expect(getRhoStatus).toHaveBeenCalledTimes(2); // initial load + post-fit refresh
  });

  it("fitting rho with a competition ID sends it through and reports a scoped fit, not a global one", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const fitRhoSpy = vi.spyOn(api, "fitDixonColesRho").mockResolvedValue({
      data: {
        runId: "run-1",
        modelVersionId: "mv-poisson",
        competitionId: "comp-1",
        sampleSize: 40,
        skipped: 2,
        informativeMatches: 40,
        fittedRho: -0.42,
        logLikelihoodAtFittedRho: -10,
        logLikelihoodAtDefaultRho: -20,
        defaultRho: -0.1
      }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Fit Dixon-Coles rho (global)")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2024-01-31" } });
    fireEvent.change(screen.getByLabelText("Rho competition ID (optional)"), { target: { value: "comp-1" } });

    await waitFor(() => expect(screen.getByText("Fit Dixon-Coles rho (this competition)")).toBeTruthy());
    screen.getByText("Fit Dixon-Coles rho (this competition)").click();

    await waitFor(() => expect(fitRhoSpy).toHaveBeenCalledTimes(1));
    expect(fitRhoSpy).toHaveBeenCalledWith("admin-token", "2024-01-01T00:00:00.000Z", "2024-01-31T23:59:59.999Z", "comp-1");
    await waitFor(() => expect(screen.getByText(/Fitted rho = -0.4200 from 40 matches/)).toBeTruthy());
    expect(screen.getByText(/stored for this competition only/)).toBeTruthy();
  });

  it("shows an error message when fitting rho fails (e.g. too few informative matches in range)", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "fitDixonColesRho").mockRejectedValue(
      new api.ApiRequestError("Need at least 30 matches finishing 0-0, 1-0, 0-1, or 1-1 to fit rho, got 2 out of 50 rows.", 422)
    );

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Fit Dixon-Coles rho (global)")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2024-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2024-01-31" } });

    screen.getByText("Fit Dixon-Coles rho (global)").click();

    await waitFor(() =>
      expect(screen.getByText("Need at least 30 matches finishing 0-0, 1-0, 0-1, or 1-1 to fit rho, got 2 out of 50 rows.")).toBeTruthy()
    );
  });

  it("renders each competition's real calibrated league averages", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({
      data: [
        {
          id: "lc-1",
          competition_id: "comp-1",
          competitionName: "Synthetic Premier Division",
          league_avg_home_goals: 1.92,
          league_avg_away_goals: 1.34,
          sample_size: 42,
          computed_at: "2026-08-27T00:00:00Z"
        }
      ]
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("Synthetic Premier Division")).toBeTruthy());
    expect(screen.getByText("1.92")).toBeTruthy();
    expect(screen.getByText("1.34")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("shows a plain-language message, not an empty table, when no competition is calibrated yet", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });

    renderDashboard();

    await waitFor(() => expect(screen.getByText(/No competition has enough real fixture history/)).toBeTruthy());
  });

  it("renders each competition's own fitted rho, separately from the global fit", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionRhoResults").mockResolvedValue({
      data: [
        {
          id: "cr-1",
          model_version_id: "mv-poisson",
          competition_id: "comp-1",
          competitionName: "Synthetic Premier Division",
          fitted_rho: -0.27,
          default_rho: -0.1,
          sample_size: 40,
          informative_matches: 40,
          log_likelihood_at_fitted_rho: -10,
          log_likelihood_at_default_rho: -20,
          evaluation_window: "2024-01-01T00:00:00.000Z..2024-01-31T23:59:59.999Z",
          computed_at: "2026-08-27T00:00:00Z"
        }
      ]
    });

    renderDashboard();

    await waitFor(() => expect(screen.getByText("Synthetic Premier Division")).toBeTruthy());
    expect(screen.getByText("-0.2700")).toBeTruthy();
  });

  it("shows a plain-language message, not an empty table, when no competition has its own rho fit yet", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionRhoResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getEnsembleWeights").mockResolvedValue({
      data: { elo: 0.2667, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667, isDefault: true }
    });
    vi.spyOn(api, "getScreeningConfig").mockResolvedValue({
      data: {
        scoreWeights: { ensembleConfidence: 0.4, ev: 0.3, consensus: 0.2, dataQuality: 0.1 },
        riskThresholds: { eliteMin: 85, strongMin: 70, mediumMin: 50, highRiskMin: 30 },
        isDefault: true
      }
    });
    vi.spyOn(api, "getAccumulatorTargets").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getCompetitionAllowlist").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagues").mockResolvedValue({ data: [] });

    renderDashboard();

    await waitFor(() => expect(screen.getByText(/No competition has a rho fit of its own yet/)).toBeTruthy());
  });

  it("triggering the league calibration sync hits its own route and refreshes results", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const getLeagueCalibrationResults = vi.spyOn(api, "getLeagueCalibrationResults").mockResolvedValue({ data: [] });
    const triggerSync = vi.spyOn(api, "triggerSync").mockResolvedValue({ data: { competitionsCalibrated: 3, competitionsSkipped: 1 } });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Sync League calibration")).toBeTruthy());

    screen.getByText("Sync League calibration").click();

    await waitFor(() => expect(triggerSync).toHaveBeenCalledWith("admin-token", "/admin/league-calibration/run"));
    expect(getLeagueCalibrationResults).toHaveBeenCalledTimes(2); // initial load + post-trigger refresh
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

  it("edits and saves the ensemble weights, then refreshes", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    const setEnsembleWeights = vi.spyOn(api, "setEnsembleWeights").mockResolvedValue({
      data: { elo: 0.5, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667, isDefault: false }
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Save weights")).toBeTruthy());

    const eloInput = screen.getByLabelText("Elo") as HTMLInputElement;
    fireEvent.change(eloInput, { target: { value: "0.5" } });
    screen.getByText("Save weights").click();

    await waitFor(() =>
      expect(setEnsembleWeights).toHaveBeenCalledWith(
        "admin-token",
        expect.objectContaining({ elo: 0.5, poisson: 0.2, form: 0.2, homeAway: 0.1333, injuries: 0.1333, market: 0.0667 })
      )
    );
  });

  it("shows a plain-language message, not an empty toggle table, when no competitions exist yet", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });

    renderDashboard();

    await waitFor(() => expect(screen.getByText(/no competitions exist yet/i)).toBeTruthy());
  });

  it("toggling a competition's allowlist entry calls the API with the new state and refreshes", async () => {
    mockBaselineDashboard();
    vi.spyOn(api, "getBacktestResults").mockResolvedValue({ data: [] });
    vi.spyOn(api, "getLeagues").mockResolvedValue({
      data: [{ id: "comp-1", country_id: null, name: "Premier League", short_name: null, tier: 1, competition_type: "league", is_active: true }]
    });
    const setCompetitionAllowlistEntry = vi.spyOn(api, "setCompetitionAllowlistEntry").mockResolvedValue({ data: [] });

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Premier League")).toBeTruthy());

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    await waitFor(() => expect(setCompetitionAllowlistEntry).toHaveBeenCalledWith("admin-token", "comp-1", true));
  });
});
