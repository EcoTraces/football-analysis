import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { RequireAdmin } from "./components/RequireAdmin";
import { AdminLayout } from "./components/AdminLayout";
import { FixturesToday } from "./pages/FixturesToday";
import { MatchDetail } from "./pages/MatchDetail";
import { Top20 } from "./pages/Top20";
import { MatchesToAvoid } from "./pages/MatchesToAvoid";
import { SignIn } from "./pages/SignIn";
import { SignUp } from "./pages/SignUp";
import { AdminDashboard } from "./pages/admin/AdminDashboard";
import { AdminUsers } from "./pages/admin/AdminUsers";

// The football data itself requires a signed-in account — only /sign-in
// and /sign-up are reachable without one (see README.md → "User access
// control"). The backend enforces the same thing independently
// (requireAuth on fixtures/matches/teams/competitions), so this isn't
// just a UI-level gate that a direct API call could bypass.
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            <RequireAuth>
              <FixturesToday />
            </RequireAuth>
          }
        />
        <Route
          path="matches/:id"
          element={
            <RequireAuth>
              <MatchDetail />
            </RequireAuth>
          }
        />
        <Route
          path="top20"
          element={
            <RequireAuth>
              <Top20 />
            </RequireAuth>
          }
        />
        <Route
          path="matches-to-avoid"
          element={
            <RequireAuth>
              <MatchesToAvoid />
            </RequireAuth>
          }
        />
        <Route path="sign-in" element={<SignIn />} />
        <Route path="sign-up" element={<SignUp />} />
        <Route
          path="admin"
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminUsers />} />
        </Route>
      </Route>
    </Routes>
  );
}
