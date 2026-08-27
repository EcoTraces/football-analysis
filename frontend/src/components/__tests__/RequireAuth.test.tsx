import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthContext, type AuthContextValue } from "../../lib/auth";
import { RequireAuth } from "../RequireAuth";

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

function renderProtected(value: AuthContextValue) {
  return render(
    <MemoryRouter initialEntries={["/protected"]}>
      <AuthContext.Provider value={value}>
        <Routes>
          <Route
            path="/protected"
            element={
              <RequireAuth>
                <div>secret content</div>
              </RequireAuth>
            }
          />
          <Route path="/sign-in" element={<div>sign-in page</div>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe("RequireAuth", () => {
  it("shows an explicit not-configured message rather than a blank or broken page", () => {
    renderProtected(baseAuthValue({ status: "not-configured" }));
    expect(screen.getByRole("alert").textContent).toMatch(/not configured/i);
    expect(screen.queryByText("secret content")).toBeNull();
  });

  it("shows a loading state while the session is still resolving", () => {
    renderProtected(baseAuthValue({ status: "loading" }));
    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(screen.queryByText("secret content")).toBeNull();
  });

  it("redirects to /sign-in when signed out", () => {
    renderProtected(baseAuthValue({ status: "signed-out" }));
    expect(screen.getByText("sign-in page")).toBeTruthy();
    expect(screen.queryByText("secret content")).toBeNull();
  });

  it("renders the protected children when signed in", () => {
    renderProtected(baseAuthValue({ status: "signed-in" }));
    expect(screen.getByText("secret content")).toBeTruthy();
  });
});
