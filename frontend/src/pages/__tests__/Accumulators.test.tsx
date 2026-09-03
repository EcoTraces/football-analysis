import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { Accumulators } from "../Accumulators";
import * as api from "../../lib/api";
import type { AccumulatorRecommendation } from "../../lib/types";
import { findBannedPhrases } from "../../lib/bannedPhrases";

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
        <Accumulators />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function recommendation(overrides: Partial<AccumulatorRecommendation> = {}): AccumulatorRecommendation {
  return {
    id: "acc-1",
    targetLegs: 5,
    legs: [
      {
        ensemblePredictionId: "ep-1",
        fixtureId: "fx-1",
        market: "1x2",
        selection: "home",
        odds: 1.8,
        homeTeamName: "Home United",
        awayTeamName: "Away City",
        kickoffUtc: "2027-01-02T15:00:00Z",
        selectionScore: 78
      }
    ],
    combinedProbability: 0.35,
    combinedDecimalOdds: 5.2,
    correlationPenalty: 0,
    compositeScore: 74,
    riskTier: "strong",
    isBestOverall: false,
    generatedAt: "2027-01-01T00:00:00Z",
    ...overrides
  };
}

describe("Accumulators", () => {
  it("shows a loading state before data resolves", () => {
    vi.spyOn(api, "getAccumulators").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status", { name: /loading accumulators/i })).toBeTruthy();
  });

  it("renders a card per target with combined odds, probability, and score", async () => {
    vi.spyOn(api, "getAccumulators").mockResolvedValue({ data: [recommendation()] });
    renderPage();

    await waitFor(() => expect(screen.getByText("ACCA 5")).toBeTruthy());
    expect(screen.getByText("5.20")).toBeTruthy();
    expect(screen.getByText("35.0%")).toBeTruthy();
    expect(screen.getByText("Strong")).toBeTruthy();
  });

  it("shows a 'Best overall' badge only on the flagged recommendation", async () => {
    vi.spyOn(api, "getAccumulators").mockResolvedValue({
      data: [recommendation({ id: "acc-5", targetLegs: 5, isBestOverall: true }), recommendation({ id: "acc-7", targetLegs: 7, isBestOverall: false })]
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("ACCA 5")).toBeTruthy());
    expect(screen.getAllByText("Best overall")).toHaveLength(1);
  });

  it("shows the correlation penalty note only when it is above zero", async () => {
    vi.spyOn(api, "getAccumulators").mockResolvedValue({ data: [recommendation({ correlationPenalty: 0.16 })] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/correlation penalty: 16%/)).toBeTruthy());
  });

  it("shows a plain-language empty state, never a forced accumulator, when nothing qualifies", async () => {
    vi.spyOn(api, "getAccumulators").mockResolvedValue({ data: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/No high-confidence accumulator today/)).toBeTruthy());
  });

  it("shows an error state with a working retry", async () => {
    const spy = vi.spyOn(api, "getAccumulators").mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ data: [recommendation()] });
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    screen.getByText("Retry").click();

    await waitFor(() => expect(screen.getByText("ACCA 5")).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never renders any of the platform's banned certainty-language phrases", async () => {
    vi.spyOn(api, "getAccumulators").mockResolvedValue({ data: [recommendation()] });
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText("ACCA 5")).toBeTruthy());
    expect(findBannedPhrases(container.textContent ?? "")).toEqual([]);
  });
});
