import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAdmin } from "./components/RequireAdmin";
import { FixturesToday } from "./pages/FixturesToday";
import { MatchDetail } from "./pages/MatchDetail";
import { SignIn } from "./pages/SignIn";
import { SignUp } from "./pages/SignUp";
import { AdminUsers } from "./pages/admin/AdminUsers";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<FixturesToday />} />
        <Route path="matches/:id" element={<MatchDetail />} />
        <Route path="sign-in" element={<SignIn />} />
        <Route path="sign-up" element={<SignUp />} />
        <Route
          path="admin/users"
          element={
            <RequireAdmin>
              <AdminUsers />
            </RequireAdmin>
          }
        />
      </Route>
    </Routes>
  );
}
