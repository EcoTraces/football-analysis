import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === "not-configured") {
    return (
      <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Authentication is not configured on this deployment (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
      </p>
    );
  }
  if (status === "loading") {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Loading your account…</p>;
  }
  if (status === "signed-out") {
    return <Navigate to="/sign-in" replace />;
  }
  return <>{children}</>;
}
