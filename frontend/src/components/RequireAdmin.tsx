import type { ReactNode } from "react";
import { RequireAuth } from "./RequireAuth";
import { useAuth } from "../lib/auth";

function RequireAdminInner({ children }: { children: ReactNode }) {
  const { profile } = useAuth();

  // Profile loads asynchronously right after sign-in (a separate request to
  // GET /me) — this is "still figuring out your role," not "you're not an
  // admin," so it gets its own state rather than briefly flashing Forbidden.
  if (!profile) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Checking your account…</p>;
  }
  if (profile.role !== "admin") {
    return (
      <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        This page requires an administrator account.
      </p>
    );
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <RequireAdminInner>{children}</RequireAdminInner>
    </RequireAuth>
  );
}
