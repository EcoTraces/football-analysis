import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { Top20 } from "../Top20";
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
        <Top20 />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function row(overrides: Partial<EnsemblePredictionRow> = {}): EnsemblePredictionRow {
  return {
    id: "ep-1",
    fixtureId: "fx-1",
    market: "1x2",
    selection: "home",
    combinedProbability: 0.62,
    consensusLevel: "high",
    selectionScore: 78,
    riskTier: "strong",
    ev: 0.08,
    edgePct: 6.5,
    bestOdds: 2.1,
    bestBookmaker: "book-a",
    dataQuality: "strong",
    missingComponents: [],
    factors: [],
    generatedAt: "2027-01-01T00:00:00Z",
    competitionName: "Premier League",
    homeTeamName: "Home United",
    awayTeamName: "Away City",
    kickoffUtc: "2027-01-02T15:00:00Z",
    ...overrides
  };
}

describe("Top20", () => {
  it("shows a loading state before data resolves", () => {
    vi.spyOn(api, "getTop20").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText(/loading top 20/i)).toBeTruthy();
  });

  it("renders each row's team names, pick, model percentage, and risk tier", async () => {
    vi.spyOn(api, "getTop20").mockResolvedValue({ data: [row()] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Home United/)).toBeTruthy());
    expect(screen.getByText(/Away City/)).toBeTruthy();
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("62.0%")).toBeTruthy();
    expect(screen.getByText("Strong")).toBeTruthy();
  });

  it("shows 'Odds unavailable' rather than a fabricated edge/EV when ev is null", async () => {
    vi.spyOn(api, "getTop20").mockResolvedValue({ data: [row({ ev: null, edgePct: null })] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Odds unavailable/)).toBeTruthy());
  });

  it("shows a plain-language empty state, never claiming a forced pick, when nothing qualifies", async () => {
    vi.spyOn(api, "getTop20").mockResolvedValue({ data: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/No high-confidence opportunities today/)).toBeTruthy());
  });

  it("shows an error state with a working retry", async () => {
    const spy = vi.spyOn(api, "getTop20").mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ data: [row()] });
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    screen.getByText("Retry").click();

    await waitFor(() => expect(screen.getByText(/Home United/)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
