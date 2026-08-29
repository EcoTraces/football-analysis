import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { MatchDetail } from "../MatchDetail";
import * as api from "../../lib/api";
import type { MatchDetail as MatchDetailType, PredictionView } from "../../lib/types";

function authValue(): AuthContextValue {
  return {
    status: "signed-in",
    session: { access_token: "user-token" } as AuthContextValue["session"],
    profile: { id: "user-1", email: "user@example.com", displayName: null, role: "user", createdAt: "2026-01-01T00:00:00Z" },
    signInWithPassword: async () => ({ error: null }),
    signUp: async () => ({ error: null, emailConfirmationRequired: false }),
    signOut: async () => {}
  };
}

function renderPage() {
  return render(
    <AuthContext.Provider value={authValue()}>
      <MemoryRouter initialEntries={["/matches/fx-1"]}>
        <Routes>
          <Route path="/matches/:id" element={<MatchDetail />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function prediction(overrides: Partial<PredictionView> = {}): PredictionView {
  return {
    market: "1x2",
    selection: "home",
    probability: 0.6,
    confidence: "high",
    dataQuality: "strong",
    riskClassification: "low",
    factors: [{ direction: "positive", label: "Strong home form" }],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE",
    ...overrides
  };
}

function match(overrides: Partial<MatchDetailType> = {}): MatchDetailType {
  return {
    id: "fx-1",
    competition_id: "comp-1",
    home_team_id: "team-home-uuid",
    away_team_id: "team-away-uuid",
    homeTeamName: "Synthetic United",
    awayTeamName: "Synthetic City",
    kickoff_utc: "2026-08-29T15:00:00Z",
    status: "scheduled",
    home_score: null,
    away_score: null,
    importance_tags: [],
    freshness: "LIVE",
    predictions: [prediction()],
    predictionsAvailable: true,
    ...overrides
  };
}

describe("MatchDetail", () => {
  it("renders the real team names in the header, not raw ids", async () => {
    vi.spyOn(api, "getMatch").mockResolvedValue({ data: match() });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Synthetic United/)).toBeTruthy());
    expect(screen.getByText(/Synthetic City/)).toBeTruthy();
    expect(screen.queryByText("team-home-uuid")).toBeNull();
  });

  it("falls back to the raw team id when a name is missing", async () => {
    vi.spyOn(api, "getMatch").mockResolvedValue({ data: match({ homeTeamName: null, awayTeamName: null }) });
    renderPage();

    await waitFor(() => expect(screen.getByText(/team-home-uuid/)).toBeTruthy());
  });

  it("gives the 1x2 market prominence as the primary prediction, outside the secondary-markets disclosure", async () => {
    vi.spyOn(api, "getMatch").mockResolvedValue({
      data: match({ predictions: [prediction(), prediction({ market: "btts", selection: "yes", probability: 0.7 })] })
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("Model prediction — Match result")).toBeTruthy());
    // The secondary market lives behind the disclosure, not inline at the top.
    expect(screen.getByText("More markets & analysis")).toBeTruthy();
    expect(screen.getByText("Both teams to score")).toBeTruthy();
  });

  it("shows a plain-language empty state when no prediction exists yet", async () => {
    vi.spyOn(api, "getMatch").mockResolvedValue({ data: match({ predictions: [], predictionsAvailable: false }) });
    renderPage();

    await waitFor(() => expect(screen.getByText(/No prediction available for this match/)).toBeTruthy());
  });

  it("shows an error state with a working retry", async () => {
    const spy = vi
      .spyOn(api, "getMatch")
      .mockRejectedValueOnce(new Error("service down"))
      .mockResolvedValueOnce({ data: match() });
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/service down/)).toBeTruthy();

    screen.getByText("Retry").click();

    await waitFor(() => expect(screen.getByText(/Synthetic United/)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
