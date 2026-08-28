import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  ApiRequestError,
  fitDixonColesRho,
  getAdminDataHealth,
  getAdminJobs,
  getAdminJobsSummary,
  getApiFootballHealth,
  getBacktestResults,
  getDataHealth,
  getRhoStatus,
  getSchedulerHealth,
  runBacktest,
  trainGradientBoosting,
  triggerSync,
  SYNC_ACTIONS,
  type SyncAction
} from "../../lib/api";
import type {
  AdminDataHealthCounts,
  ApiFootballHealth,
  BacktestableModel,
  BacktestEvaluation,
  DataHealth,
  IngestionRun,
  JobsSummary,
  RhoStatus,
  SchedulerHealth
} from "../../lib/types";
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
  backtestResults: BacktestEvaluation[] | null;
  backtestResultsError: string | null;
  rhoStatus: RhoStatus | null;
  rhoStatusError: string | null;
}

type SyncActionState =
  | { status: "pending" }
  | { status: "success"; result: Record<string, unknown> }
  | { status: "error"; message: string };

type BacktestRunState = { status: "pending" } | { status: "error"; message: string } | null;
type TrainRunState = { status: "pending" } | { status: "success"; sampleSize: number; trainAccuracy: number | null } | { status: "error"; message: string } | null;
type FitRhoRunState = { status: "pending" } | { status: "success"; fittedRho: number; sampleSize: number } | { status: "error"; message: string } | null;

const MODEL_LABELS: Record<BacktestableModel, string> = {
  "poisson-baseline": "Poisson baseline",
  "gradient-boosting": "Gradient boosting"
};

function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

// The dashboard the six sync jobs + predictions + scheduler + provider
// connectivity have always had an API for, but never a UI (see
// Architecture.md's "Deliberately deferred" list) — this reads all of it
// back and lets an admin trigger any job by hand, same as the curl chain
// in README.md but without a terminal.
export function AdminDashboard() {
  const { session } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncState, setSyncState] = useState<Record<string, SyncActionState>>({});
  const [backtestFrom, setBacktestFrom] = useState("");
  const [backtestTo, setBacktestTo] = useState("");
  const [backtestModel, setBacktestModel] = useState<BacktestableModel>("poisson-baseline");
  const [backtestRunState, setBacktestRunState] = useState<BacktestRunState>(null);
  const [trainRunState, setTrainRunState] = useState<TrainRunState>(null);
  const [fitRhoRunState, setFitRhoRunState] = useState<FitRhoRunState>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    const token = session.access_token;

    const [
      [dataHealth, dataHealthError],
      [apiFootballHealth, apiFootballError],
      [schedulerHealth, schedulerError],
      [jobsSummaryRes, jobsSummaryError],
      [recentJobsRes, recentJobsError],
      [fixtureCountsRes, fixtureCountsError],
      [backtestResultsRes, backtestResultsError],
      [rhoStatusRes, rhoStatusError]
    ] = await Promise.all([
      loadPiece(() => getDataHealth()),
      loadPiece(() => getApiFootballHealth()),
      loadPiece(() => getSchedulerHealth()),
      loadPiece(() => getAdminJobsSummary(token)),
      loadPiece(() => getAdminJobs(token, 20)),
      loadPiece(() => getAdminDataHealth(token)),
      loadPiece(() => getBacktestResults(token, 20)),
      loadPiece(() => getRhoStatus(token))
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
      fixtureCountsError,
      backtestResults: backtestResultsRes?.data ?? null,
      backtestResultsError,
      rhoStatus: rhoStatusRes?.data ?? null,
      rhoStatusError
    });
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRunBacktest() {
    if (!session || !backtestFrom || !backtestTo) return;
    setBacktestRunState({ status: "pending" });
    try {
      // Treat the plain <input type="date"> values as UTC day boundaries —
      // simplest correct behavior for a range picker with no timezone control.
      await runBacktest(session.access_token, `${backtestFrom}T00:00:00.000Z`, `${backtestTo}T23:59:59.999Z`, undefined, backtestModel);
      setBacktestRunState(null);
      await refresh();
    } catch (err) {
      setBacktestRunState({
        status: "error",
        message: err instanceof ApiRequestError ? err.message : "Failed to run backtest."
      });
    }
  }

  async function handleTrainGradientBoosting() {
    if (!session || !backtestFrom || !backtestTo) return;
    setTrainRunState({ status: "pending" });
    try {
      const res = await trainGradientBoosting(session.access_token, `${backtestFrom}T00:00:00.000Z`, `${backtestTo}T23:59:59.999Z`);
      setTrainRunState({ status: "success", sampleSize: res.data.sampleSize, trainAccuracy: res.data.trainAccuracy });
      await refresh();
    } catch (err) {
      setTrainRunState({
        status: "error",
        message: err instanceof ApiRequestError ? err.message : "Failed to train gradient boosting model."
      });
    }
  }

  async function handleFitRho() {
    if (!session || !backtestFrom || !backtestTo) return;
    setFitRhoRunState({ status: "pending" });
    try {
      const res = await fitDixonColesRho(session.access_token, `${backtestFrom}T00:00:00.000Z`, `${backtestTo}T23:59:59.999Z`);
      setFitRhoRunState(
        res.data.fittedRho === null
          ? null
          : { status: "success", fittedRho: res.data.fittedRho, sampleSize: res.data.sampleSize }
      );
      await refresh();
    } catch (err) {
      setFitRhoRunState({
        status: "error",
        message: err instanceof ApiRequestError ? err.message : "Failed to fit Dixon-Coles rho."
      });
    }
  }

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
        <h2 className="mb-3 text-lg font-semibold">Backtest &amp; models (1x2 market)</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Walk-forward evaluation: for each finished fixture in the chosen range, team strength is recomputed from only
          the matches that finished strictly before its own kickoff (never from the current team_statistics snapshot,
          which would leak future data into a "historical" prediction). "Run backtest" writes one model_evaluations
          row for whichever model is selected — run it once per model over the same range to compare them. "Train
          gradient boosting" fits that second model on point-in-time features from the same kind of range; it has no
          formula of its own, so predictions from it are unavailable until it's been trained at least once. "Fit
          Dixon-Coles rho" refines the Poisson baseline's own low-score correlation parameter from the same kind of
          range — once fit, every poisson-baseline prediction (and any backtest run against it) uses the fitted value
          instead of the fixed -0.1 approximation. Only matches finishing 0-0, 1-0, 0-1, or 1-1 carry any information
          for that fit — every other scoreline contributes nothing to it, by construction of the Dixon-Coles model.
          Only meaningful once real historical fixture results exist in this database — synthetic dev-seed fixtures
          are always excluded from all three.
        </p>
        {data.rhoStatusError ? (
          <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
            {data.rhoStatusError}
          </p>
        ) : (
          data.rhoStatus && (
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Current poisson-baseline rho:{" "}
              <strong className="text-slate-700 dark:text-slate-300">
                {data.rhoStatus.fittedRho === null ? `${data.rhoStatus.defaultRho} (fixed default, never fit)` : data.rhoStatus.fittedRho.toFixed(4)}
              </strong>
            </p>
          )
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-slate-500 dark:text-slate-400">
            From
            <input
              type="date"
              value={backtestFrom}
              onChange={(e) => setBacktestFrom(e.target.value)}
              className="mt-1 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            />
          </label>
          <label className="flex flex-col text-xs text-slate-500 dark:text-slate-400">
            To
            <input
              type="date"
              value={backtestTo}
              onChange={(e) => setBacktestTo(e.target.value)}
              className="mt-1 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            />
          </label>
          <label className="flex flex-col text-xs text-slate-500 dark:text-slate-400">
            Model
            <select
              value={backtestModel}
              onChange={(e) => setBacktestModel(e.target.value as BacktestableModel)}
              className="mt-1 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            >
              {(Object.keys(MODEL_LABELS) as BacktestableModel[]).map((model) => (
                <option key={model} value={model}>
                  {MODEL_LABELS[model]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!backtestFrom || !backtestTo || backtestRunState?.status === "pending"}
            onClick={() => void handleRunBacktest()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {backtestRunState?.status === "pending" ? "Running backtest…" : "Run backtest"}
          </button>
          <button
            type="button"
            disabled={!backtestFrom || !backtestTo || trainRunState?.status === "pending"}
            onClick={() => void handleTrainGradientBoosting()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {trainRunState?.status === "pending" ? "Training…" : "Train gradient boosting"}
          </button>
          <button
            type="button"
            disabled={!backtestFrom || !backtestTo || fitRhoRunState?.status === "pending"}
            onClick={() => void handleFitRho()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {fitRhoRunState?.status === "pending" ? "Fitting…" : "Fit Dixon-Coles rho"}
          </button>
        </div>
        {backtestRunState?.status === "error" && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {backtestRunState.message}
          </p>
        )}
        {trainRunState?.status === "error" && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {trainRunState.message}
          </p>
        )}
        {trainRunState?.status === "success" && (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Trained on {trainRunState.sampleSize} fixtures — in-sample accuracy{" "}
            {trainRunState.trainAccuracy === null ? "—" : `${Math.round(trainRunState.trainAccuracy * 100)}%`} (not a held-out/generalization
            metric — back-test the model above for that).
          </p>
        )}
        {fitRhoRunState?.status === "error" && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {fitRhoRunState.message}
          </p>
        )}
        {fitRhoRunState?.status === "success" && (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Fitted rho = {fitRhoRunState.fittedRho.toFixed(4)} from {fitRhoRunState.sampleSize} matches in range — now in effect for every
            poisson-baseline prediction.
          </p>
        )}

        <div className="mt-4">
          {data.backtestResultsError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {data.backtestResultsError}
            </p>
          )}
          {data.backtestResults && data.backtestResults.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">No backtest runs yet.</p>
          )}
          {data.backtestResults && data.backtestResults.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800">
                    <th className="py-2 pr-4 font-medium">Model</th>
                    <th className="py-2 pr-4 font-medium">Window</th>
                    <th className="py-2 pr-4 font-medium">Sample size</th>
                    <th className="py-2 pr-4 font-medium">Accuracy</th>
                    <th className="py-2 pr-4 font-medium">Log loss</th>
                    <th className="py-2 font-medium">Brier score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.backtestResults.map((run) => (
                    <tr key={run.id} className="border-b border-slate-100 dark:border-slate-900">
                      <td className="py-2 pr-4">{run.modelName ?? run.model_version_id}</td>
                      <td className="py-2 pr-4 text-xs text-slate-500 dark:text-slate-400">{run.evaluation_window}</td>
                      <td className="py-2 pr-4">{run.sample_size}</td>
                      <td className="py-2 pr-4">{run.accuracy === null ? "—" : `${Math.round(run.accuracy * 100)}%`}</td>
                      <td className="py-2 pr-4">{formatMetric(run.log_loss)}</td>
                      <td className="py-2">{formatMetric(run.brier_score)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
