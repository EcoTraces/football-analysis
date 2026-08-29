import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { FixturesToday } from "../FixturesToday";
import * as api from "../../lib/api";
import type { FixtureSummary } from "../../lib/types";

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
        <FixturesToday />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function fixture(overrides: Partial<FixtureSummary> = {}): FixtureSummary {
  return {
    id: "fx-1",
    competitionId: "comp-1",
    homeTeamId: "team-home-uuid",
    awayTeamId: "team-away-uuid",
    homeTeamName: "Synthetic United",
    awayTeamName: "Synthetic City",
    kickoffUtc: "2026-08-29T15:00:00Z",
    status: "scheduled",
    homeScore: null,
    awayScore: null,
    freshness: "LIVE" as const,
    source: "api-football",
    sourceTimestamp: "2026-08-29T14:00:00Z",
    ...overrides
  };
}

describe("FixturesToday", () => {
  it("shows a loading skeleton before data resolves", () => {
    vi.spyOn(api, "getTodayFixtures").mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status", { name: /loading fixtures/i })).toBeTruthy();
  });

  it("renders each fixture's real team names, not raw ids", async () => {
    vi.spyOn(api, "getTodayFixtures").mockResolvedValue({ data: [fixture()] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Synthetic United/)).toBeTruthy());
    expect(screen.getByText(/Synthetic City/)).toBeTruthy();
    expect(screen.queryByText("team-home-uuid")).toBeNull();
  });

  it("falls back to the raw team id when a team has no name yet, rather than showing nothing", async () => {
    vi.spyOn(api, "getTodayFixtures").mockResolvedValue({
      data: [fixture({ homeTeamName: null, awayTeamName: null })]
    });
    renderPage();

    await waitFor(() => expect(screen.getByText(/team-home-uuid/)).toBeTruthy());
    expect(screen.getByText(/team-away-uuid/)).toBeTruthy();
  });

  it("shows a plain-language empty state, not a blank list, when there are no fixtures", async () => {
    vi.spyOn(api, "getTodayFixtures").mockResolvedValue({ data: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/No fixtures available for today/)).toBeTruthy());
  });

  it("shows an error state with a working retry that re-fetches", async () => {
    const spy = vi
      .spyOn(api, "getTodayFixtures")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ data: [fixture()] });
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/network down/)).toBeTruthy();

    screen.getByText("Retry").click();

    await waitFor(() => expect(screen.getByText(/Synthetic United/)).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
