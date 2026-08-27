import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  ApiRequestError,
  getAdminDataHealth,
  getAdminJobs,
  getAdminJobsSummary,
  getApiFootballHealth,
  getDataHealth,
  getSchedulerHealth,
  triggerSync,
  SYNC_ACTIONS,
  type SyncAction
} from "../../lib/api";
import type { AdminDataHealthCounts, ApiFootballHealth, DataHealth, IngestionRun, JobsSummary, SchedulerHealth } from "../../lib/types";
import { FreshnessBadge } from "../../components/FreshnessBadge";

const STATUS_STYLES: Record<string, string> = {
  CONNECTED: "bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-100",
  RUNNING: "bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-100",
  reachable: "bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-100",
  succeeded: "bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-100",
  UNKNOWN: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  DISABLED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  NOT_CONFIGURED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  running: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  partial: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  ERROR: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  unreachable: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  failed: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100"
};

function StatusBadge({ status }: { status: string }) {
  const className = STATUS_STYLES[status] ?? "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{status}</span>;
}

function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

async function loadPiece<T>(fn: () => Promise<T>): Promise<[T | null, string | null]> {
  try {
    return [await fn(), null];
  } catch (err) {
    return [null, err instanceof ApiRequestError ? err.message : "Failed to load."];
  }
}

interface DashboardData {
  dataHealth: DataHealth | null;
  dataHealthError: string | null;
  apiFootballHealth: ApiFootballHealth | null;
  apiFootballError: string | null;
  schedulerHealth: SchedulerHealth | null;
  schedulerError: string | null;
  jobsSummary: JobsSummary | null;
  jobsSummaryError: string | null;
  recentJobs: IngestionRun[] | null;
  recentJobsError: string | null;
  fixtureCounts: AdminDataHealthCounts | null;
  fixtureCountsError: string | null;
}

type SyncActionState =
  | { status: "pending" }
  | { status: "success"; result: Record<string, unknown> }
  | { status: "error"; message: string };

// The dashboard the six sync jobs + predictions + scheduler + provider
// connectivity have always had an API for, but never a UI (see
// Architecture.md's "Deliberately deferred" list) — this reads all of it
// back and lets an admin trigger any job by hand, same as the curl chain
// in README.md but without a terminal.
export function AdminDashboard() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncState, setSyncState] = useState<Record<string, SyncActionState>>({});

  const refresh = useCallback(async () => {
    if (!session) return;
    const token = session.access_token;

    const [
      [dataHealth, dataHealthError],
      [apiFootballHealth, apiFootballError],
      [schedulerHealth, schedulerError],
      [jobsSummaryRes, jobsSummaryError],
      [recentJobsRes, recentJobsError],
      [fixtureCountsRes, fixtureCountsError]
    ] = await Promise.all([
      loadPiece(() => getDataHealth()),
      loadPiece(() => getApiFootballHealth()),
      loadPiece(() => getSchedulerHealth()),
      loadPiece(() => getAdminJobsSummary(token)),
      loadPiece(() => getAdminJobs(token, 20)),
      loadPiece(() => getAdminDataHealth(token))
    ]);

    setData({
      dataHealth,
      dataHealthError,
      apiFootballHealth,
      apiFootballError,
      schedulerHealth,
      schedulerError,
      jobsSummary: jobsSummaryRes?.data ?? null,
      jobsSummaryError,
      recentJobs: recentJobsRes?.data ?? null,
      recentJobsError,
      fixtureCounts: fixtureCountsRes?.data ?? null,
      fixtureCountsError
    });
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleTrigger(action: SyncAction) {
    if (!session) return;
    setSyncState((prev) => ({ ...prev, [action.key]: { status: "pending" } }));
    try {
      const res = await triggerSync(session.access_token, action.path);
      setSyncState((prev) => ({ ...prev, [action.key]: { status: "success", result: res.data } }));
      await refresh();
    } catch (err) {
      setSyncState((prev) => ({
        ...prev,
        [action.key]: { status: "error", message: err instanceof ApiRequestError ? err.message : "Failed to trigger sync." }
      }));
    }
  }

  if (!data) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading dashboard…</p>;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Dashboard</h1>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <h2 className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">Data provider</h2>
            {data.apiFootballError ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {data.apiFootballError}
              </p>
            ) : (
              data.apiFootballHealth && (
                <>
                  <StatusBadge status={data.apiFootballHealth.status} />
                  {data.apiFootballHealth.message && (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{data.apiFootballHealth.message}</p>
                  )}
                  {data.apiFootballHealth.rateLimit && (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Rate limit: {data.apiFootballHealth.rateLimit.remaining ?? "?"} / {data.apiFootballHealth.rateLimit.limit ?? "?"}{" "}
                      remaining
                    </p>
                  )}
                </>
              )
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <h2 className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">Scheduler</h2>
            {data.schedulerError ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {data.schedulerError}
              </p>
            ) : (
              data.schedulerHealth && (
                <>
                  <StatusBadge status={data.schedulerHealth.status} />
                  {data.schedulerHealth.message && (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{data.schedulerHealth.message}</p>
                  )}
                  {data.schedulerHealth.jobs.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {data.schedulerHealth.jobs.map((job) => (
                        <li key={job.name}>
                          {job.name} — next {formatDateTime(job.nextRun)}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <h2 className="mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">Database</h2>
            {data.dataHealthError ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {data.dataHealthError}
              </p>
            ) : (
              data.dataHealth && (
                <>
                  <StatusBadge status={data.dataHealth.database} />
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Provider: {data.dataHealth.provider} ({data.dataHealth.providerConfigured ? "configured" : "not configured"})
                  </p>
                  {data.fixtureCounts && (
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      {data.fixtureCounts.productionFixtures} production fixtures · {data.fixtureCounts.syntheticFixtures} synthetic ·{" "}
                      {data.fixtureCounts.currentPredictions} current predictions
                    </p>
                  )}
                </>
              )
            )}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Data freshness</h2>
        {data.dataHealthError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.dataHealthError}
          </p>
        )}
        {data.dataHealth && (
          <ul className="flex flex-wrap gap-3">
            {data.dataHealth.freshness.map((entry) => (
              <li key={entry.domain} className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
                <span className="font-medium">{entry.domain}</span>
                <FreshnessBadge freshness={entry.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Manual sync</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Runs each job once, immediately, with its default window/day range — same as the scheduler's own cadence, just
          triggered by hand instead of on a cron.
        </p>
        <div className="flex flex-wrap gap-3">
          {SYNC_ACTIONS.map((action) => {
            const state = syncState[action.key];
            return (
              <div key={action.key} className="rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800">
                <button
                  type="button"
                  disabled={state?.status === "pending"}
                  onClick={() => void handleTrigger(action)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {state?.status === "pending" ? `Running ${action.label}…` : `Sync ${action.label}`}
                </button>
                {state?.status === "success" && (
                  <dl className="mt-2 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {Object.entries(state.result)
                      .filter(([key]) => key !== "runId")
                      .map(([key, value]) => (
                        <div key={key} className="flex justify-between gap-4">
                          <dt>{key}</dt>
                          <dd>{String(value)}</dd>
                        </div>
                      ))}
                  </dl>
                )}
                {state?.status === "error" && (
                  <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {state.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Job summary</h2>
        {data.jobsSummaryError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.jobsSummaryError}
          </p>
        )}
        {data.jobsSummary && Object.keys(data.jobsSummary).length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No jobs have run yet.</p>
        )}
        {data.jobsSummary && Object.keys(data.jobsSummary).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-4 font-medium">Job</th>
                  <th className="py-2 pr-4 font-medium">Last run</th>
                  <th className="py-2 pr-4 font-medium">Last run status</th>
                  <th className="py-2 font-medium">Last succeeded</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.jobsSummary).map(([jobName, entry]) => (
                  <tr key={jobName} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4">{jobName}</td>
                    <td className="py-2 pr-4 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(entry.lastRun.started_at)}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={entry.lastRun.status} />
                    </td>
                    <td className="py-2 text-xs text-slate-500 dark:text-slate-400">
                      {entry.lastSuccess ? formatDateTime(entry.lastSuccess.started_at) : "never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent job runs</h2>
        {data.recentJobsError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.recentJobsError}
          </p>
        )}
        {data.recentJobs && data.recentJobs.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No jobs have run yet.</p>
        )}
        {data.recentJobs && data.recentJobs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-4 font-medium">Job</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Started</th>
                  <th className="py-2 pr-4 font-medium">Processed</th>
                  <th className="py-2 pr-4 font-medium">Rejected</th>
                  <th className="py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {data.recentJobs.map((run) => (
                  <tr key={run.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4">{run.job_name}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="py-2 pr-4 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(run.started_at)}</td>
                    <td className="py-2 pr-4">{run.records_processed}</td>
                    <td className="py-2 pr-4">{run.records_rejected}</td>
                    <td className="py-2 max-w-xs truncate text-xs text-slate-500 dark:text-slate-400" title={run.error_summary ?? undefined}>
                      {run.error_summary ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
