import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { MatchesToAvoid } from "../MatchesToAvoid";
import * as api from "../../lib/api";
import type { EnsemblePredictionRow } from "../../lib/types";

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
      <MemoryRouter>
        <MatchesToAvoid />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function row(overrides: Partial<EnsemblePredictionRow> = {}): EnsemblePredictionRow {
  return {
    id: "ep-1",
    fixtureId: "fx-1",
    market: "1x2",
    selection: "away",
    combinedProbability: 0.4,
    consensusLevel: "conflicting",
    selectionScore: 20,
    riskTier: "high_risk",
    ev: null,
    edgePct: null,
    bestOdds: null,
    bestBookmaker: null,
    dataQuality: "insufficient",
    missingComponents: ["market"],
    factors: [],
    generatedAt: "2027-01-01T00:00:00Z",
    competitionName: "Championship",
    homeTeamName: "Home United",
    awayTeamName: "Away City",
    kickoffUtc: "2027-01-02T15:00:00Z",
    ...overrides
  };
}

describe("MatchesToAvoid", () => {
  it("shows a loading state before data resolves", () => {
    vi.spyOn(api, "getMatchesToAvoid").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status", { name: /loading matches to avoid/i })).toBeTruthy();
  });

  it("shows every applicable reason chip for a flagged selection, not just one", async () => {
    vi.spyOn(api, "getMatchesToAvoid").mockResolvedValue({ data: [row()] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Home United/)).toBeTruthy());
    expect(screen.getByText("High risk")).toBeTruthy();
    expect(screen.getByText("Conflicting signals")).toBeTruthy();
    expect(screen.getByText("Insufficient data")).toBeTruthy();
  });

  it("shows a plain-language empty state when nothing is flagged", async () => {
    vi.spyOn(api, "getMatchesToAvoid").mockResolvedValue({ data: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Nothing flagged right now/)).toBeTruthy());
  });

  it("shows an error state with a working retry", async () => {
    const spy = vi.spyOn(api, "getMatchesToAvoid").mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ data: [row()] });
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    screen.getByText("Retry").click();

    await waitFor(() => expect(screen.getByText(/Home United/)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
