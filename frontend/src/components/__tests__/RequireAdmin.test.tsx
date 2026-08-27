import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { RequireAdmin } from "../RequireAdmin";
import type { MeProfile } from "../../lib/types";

function profile(overrides: Partial<MeProfile> = {}): MeProfile {
  return { id: "user-1", email: "user@example.com", displayName: null, role: "user", createdAt: "2026-01-01T00:00:00Z", ...overrides };
}

function baseAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: "signed-in",
    session: null,
    profile: null,
    signInWithPassword: async () => ({ error: null }),
    signUp: async () => ({ error: null, emailConfirmationRequired: false }),
    signOut: async () => {},
    ...overrides
  };
}

function renderAdminPage(value: AuthContextValue) {
  return render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <AuthContext.Provider value={value}>
        <Routes>
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <div>admin panel</div>
              </RequireAdmin>
            }
          />
          <Route path="/sign-in" element={<div>sign-in page</div>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe("RequireAdmin", () => {
  it("redirects to /sign-in when signed out (delegates to RequireAuth)", () => {
    renderAdminPage(baseAuthValue({ status: "signed-out" }));
    expect(screen.getByText("sign-in page")).toBeTruthy();
  });

  it("shows a checking state while signed in but the profile hasn't loaded yet", () => {
    renderAdminPage(baseAuthValue({ status: "signed-in", profile: null }));
    expect(screen.getByText(/checking your account/i)).toBeTruthy();
    expect(screen.queryByText("admin panel")).toBeNull();
  });

  it("shows a Forbidden message for a signed-in non-admin user", () => {
    renderAdminPage(baseAuthValue({ status: "signed-in", profile: profile({ role: "user" }) }));
    expect(screen.getByRole("alert").textContent).toMatch(/administrator account/i);
    expect(screen.queryByText("admin panel")).toBeNull();
  });

  it("renders the admin panel for a signed-in admin", () => {
    renderAdminPage(baseAuthValue({ status: "signed-in", profile: profile({ role: "admin" }) }));
    expect(screen.getByText("admin panel")).toBeTruthy();
  });
});
