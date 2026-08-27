import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { ApiRequestError, listAdminUsers, setUserRole } from "../../lib/api";
import type { AdminUserSummary } from "../../lib/types";

export function AdminUsers() {
  const { session, profile } = useAuth();
  const [users, setUsers] = useState<AdminUserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const res = await listAdminUsers(session.access_token);
      setUsers(res.data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to load users.");
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRoleChange(userId: string, role: "user" | "admin") {
    if (!session) return;
    setPendingId(userId);
    setError(null);
    try {
      await setUserRole(session.access_token, userId, role);
      await load();
    } catch (err) {
      // Surfaces the backend's actual message (e.g. "Refusing to demote the
      // only remaining admin account.") rather than a generic failure.
      setError(err instanceof ApiRequestError ? err.message : "Failed to update role.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Users</h1>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Promote a regular account to administrator, or demote one back — the backend refuses to demote the last
        remaining admin.
      </p>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      {!users ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              <th className="py-2 font-medium">Email</th>
              <th className="py-2 font-medium">Role</th>
              <th className="py-2 font-medium">Joined</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 dark:border-slate-900">
                <td className="py-2">{u.email ?? "—"}</td>
                <td className="py-2">
                  <span className={u.role === "admin" ? "font-semibold text-pitch-600" : ""}>{u.role}</span>
                </td>
                <td className="py-2">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  {u.id === profile?.id ? (
                    // Disallowed in the UI, not just discouraged: demoting
                    // yourself mid-session would break requireAdmin on your
                    // very next request on this same page. The backend's
                    // last-admin check is the real safety net; this just
                    // avoids a confusing self-inflicted lockout.
                    <span className="text-xs text-slate-400">(you)</span>
                  ) : (
                    <button
                      type="button"
                      disabled={pendingId === u.id}
                      onClick={() => void handleRoleChange(u.id, u.role === "admin" ? "user" : "admin")}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      {pendingId === u.id ? "Updating…" : u.role === "admin" ? "Demote" : "Promote"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
