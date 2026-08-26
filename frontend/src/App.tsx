import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { FixturesToday } from "./pages/FixturesToday";
import { MatchDetail } from "./pages/MatchDetail";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<FixturesToday />} />
        <Route path="matches/:id" element={<MatchDetail />} />
      </Route>
    </Routes>
  );
}
