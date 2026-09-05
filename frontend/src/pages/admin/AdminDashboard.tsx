import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  ApiRequestError,
  fitDixonColesRho,
  getAccumulatorTargets,
  getAdminAuditLog,
  getAdminDataHealth,
  getAdminJobs,
  getAdminJobsSummary,
  getApiFootballHealth,
  getBacktestResults,
  getCompetitionAllowlist,
  getCompetitionRhoResults,
  getDataHealth,
  getEnsembleWeights,
  getLeagueCalibrationResults,
  getLeagues,
  getRhoStatus,
  getSchedulerHealth,
  getScreeningConfig,
  runBacktest,
  setAccumulatorTarget,
  setCompetitionAllowlistEntry,
  setEnsembleWeights,
  setScreeningConfig,
  trainGradientBoosting,
  triggerSync,
  SYNC_ACTIONS,
  type SyncAction
} from "../../lib/api";
import type {
  AccumulatorTarget,
  AdminAuditLogEntry,
  AdminDataHealthCounts,
  ApiFootballHealth,
  BacktestableModel,
  BacktestEvaluation,
  Competition,
  CompetitionAllowlistEntry,
  CompetitionRhoRow,
  DataHealth,
  EnsembleWeights,
  IngestionRun,
  JobsSummary,
  LeagueCalibrationRow,
  RhoStatus,
  SchedulerHealth,
  ScreeningConfig
} from "../../lib/types";
import { FreshnessBadge } from "../../components/FreshnessBadge";
import { Badge, type BadgeVariant } from "../../components/Badge";

// Same five-color semantic mapping FreshnessBadge uses, via the shared
// Badge component, instead of this dashboard keeping its own separate
// copy of the same green/gray/amber/red classes.
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  CONNECTED: "success",
  RUNNING: "success",
  reachable: "success",
  succeeded: "success",
  UNKNOWN: "neutral",
  DISABLED: "neutral",
  NOT_CONFIGURED: "neutral",
  running: "neutral",
  partial: "warning",
  ERROR: "danger",
  unreachable: "danger",
  failed: "danger"
};

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "neutral"}>{status}</Badge>;
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
  auditLog: AdminAuditLogEntry[] | null;
  auditLogError: string | null;
  fixtureCounts: AdminDataHealthCounts | null;
  fixtureCountsError: string | null;
  backtestResults: BacktestEvaluation[] | null;
  backtestResultsError: string | null;
  rhoStatus: RhoStatus | null;
  rhoStatusError: string | null;
  leagueCalibration: LeagueCalibrationRow[] | null;
  leagueCalibrationError: string | null;
  competitionRho: CompetitionRhoRow[] | null;
  competitionRhoError: string | null;
  ensembleWeights: EnsembleWeights | null;
  ensembleWeightsError: string | null;
  screeningConfig: ScreeningConfig | null;
  screeningConfigError: string | null;
  accumulatorTargets: AccumulatorTarget[] | null;
  accumulatorTargetsError: string | null;
  competitionAllowlist: CompetitionAllowlistEntry[] | null;
  competitionAllowlistError: string | null;
  leagues: Competition[] | null;
  leaguesError: string | null;
}

type SyncActionState =
  | { status: "pending" }
  | { status: "success"; result: Record<string, unknown> }
  | { status: "error"; message: string };

type BacktestRunState = { status: "pending" } | { status: "error"; message: string } | null;
type TrainRunState = { status: "pending" } | { status: "success"; sampleSize: number; trainAccuracy: number | null } | { status: "error"; message: string } | null;
type FitRhoRunState =
  | { status: "pending" }
  | { status: "success"; fittedRho: number; sampleSize: number; competitionId: string | null }
  | { status: "error"; message: string }
  | null;

const MODEL_LABELS: Record<BacktestableModel, string> = {
  "poisson-baseline": "Poisson baseline",
  "gradient-boosting": "Gradient boosting"
};

function formatMetric(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

type EnsembleWeightsInput = Omit<EnsembleWeights, "isDefault">;
type ScreeningConfigInput = Omit<ScreeningConfig, "isDefault">;
type SaveState = { status: "pending" } | { status: "error"; message: string } | null;

const ENSEMBLE_WEIGHT_FIELDS: { key: keyof EnsembleWeightsInput; label: string }[] = [
  { key: "elo", label: "Elo" },
  { key: "poisson", label: "Poisson" },
  { key: "form", label: "Form" },
  { key: "homeAway", label: "Home/away" },
  { key: "injuries", label: "Injuries" },
  { key: "market", label: "Market" }
];

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
  const [rhoCompetitionId, setRhoCompetitionId] = useState("");

  // AI Football Analyst config forms — seeded once from the loaded data
  // (see the seedConfigDrafts effect below) rather than re-derived on
  // every render, so a refresh() triggered by an unrelated action (e.g.
  // triggering a sync job) doesn't clobber an in-progress edit.
  const [ensembleWeightsDraft, setEnsembleWeightsDraft] = useState<EnsembleWeightsInput | null>(null);
  const [ensembleWeightsSaveState, setEnsembleWeightsSaveState] = useState<SaveState>(null);
  const [screeningConfigDraft, setScreeningConfigDraft] = useState<ScreeningConfigInput | null>(null);
  const [screeningConfigSaveState, setScreeningConfigSaveState] = useState<SaveState>(null);
  const configDraftsSeeded = useRef(false);

  // Accumulator targets and the competition allowlist are per-row edits
  // instead — each row's current draft falls back to its live server value
  // until touched, so no seeding effect is needed for these two.
  const [accumulatorTargetDrafts, setAccumulatorTargetDrafts] = useState<Record<number, { minSelectionScore: number; enabled: boolean }>>({});
  const [accumulatorTargetSaveState, setAccumulatorTargetSaveState] = useState<Record<number, SaveState>>({});
  const [allowlistSaveState, setAllowlistSaveState] = useState<Record<string, SaveState>>({});

  const refresh = useCallback(async () => {
    if (!session) return;
    const token = session.access_token;

    const [
      [dataHealth, dataHealthError],
      [apiFootballHealth, apiFootballError],
      [schedulerHealth, schedulerError],
      [jobsSummaryRes, jobsSummaryError],
      [recentJobsRes, recentJobsError],
      [auditLogRes, auditLogError],
      [fixtureCountsRes, fixtureCountsError],
      [backtestResultsRes, backtestResultsError],
      [rhoStatusRes, rhoStatusError],
      [leagueCalibrationRes, leagueCalibrationError],
      [competitionRhoRes, competitionRhoError],
      [ensembleWeightsRes, ensembleWeightsError],
      [screeningConfigRes, screeningConfigError],
      [accumulatorTargetsRes, accumulatorTargetsError],
      [competitionAllowlistRes, competitionAllowlistError],
      [leaguesRes, leaguesError]
    ] = await Promise.all([
      loadPiece(() => getDataHealth()),
      loadPiece(() => getApiFootballHealth()),
      loadPiece(() => getSchedulerHealth()),
      loadPiece(() => getAdminJobsSummary(token)),
      loadPiece(() => getAdminJobs(token, 20)),
      loadPiece(() => getAdminAuditLog(token, 20)),
      loadPiece(() => getAdminDataHealth(token)),
      loadPiece(() => getBacktestResults(token, 20)),
      loadPiece(() => getRhoStatus(token)),
      loadPiece(() => getLeagueCalibrationResults(token)),
      loadPiece(() => getCompetitionRhoResults(token)),
      loadPiece(() => getEnsembleWeights(token)),
      loadPiece(() => getScreeningConfig(token)),
      loadPiece(() => getAccumulatorTargets(token)),
      loadPiece(() => getCompetitionAllowlist(token)),
      loadPiece(() => getLeagues(token))
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
      auditLog: auditLogRes?.data ?? null,
      auditLogError,
      fixtureCounts: fixtureCountsRes?.data ?? null,
      fixtureCountsError,
      backtestResults: backtestResultsRes?.data ?? null,
      backtestResultsError,
      rhoStatus: rhoStatusRes?.data ?? null,
      rhoStatusError,
      leagueCalibration: leagueCalibrationRes?.data ?? null,
      leagueCalibrationError,
      competitionRho: competitionRhoRes?.data ?? null,
      competitionRhoError,
      ensembleWeights: ensembleWeightsRes?.data ?? null,
      ensembleWeightsError,
      screeningConfig: screeningConfigRes?.data ?? null,
      screeningConfigError,
      accumulatorTargets: accumulatorTargetsRes?.data ?? null,
      accumulatorTargetsError,
      competitionAllowlist: competitionAllowlistRes?.data ?? null,
      competitionAllowlistError,
      leagues: leaguesRes?.data ?? null,
      leaguesError
    });
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (configDraftsSeeded.current || !data?.ensembleWeights || !data.screeningConfig) return;
    const weights = data.ensembleWeights;
    setEnsembleWeightsDraft({
      elo: weights.elo,
      poisson: weights.poisson,
      form: weights.form,
      homeAway: weights.homeAway,
      injuries: weights.injuries,
      market: weights.market
    });
    const config = data.screeningConfig;
    setScreeningConfigDraft({ scoreWeights: config.scoreWeights, riskThresholds: config.riskThresholds });
    configDraftsSeeded.current = true;
  }, [data]);

  async function handleSaveEnsembleWeights() {
    if (!session || !ensembleWeightsDraft) return;
    setEnsembleWeightsSaveState({ status: "pending" });
    try {
      await setEnsembleWeights(session.access_token, ensembleWeightsDraft);
      setEnsembleWeightsSaveState(null);
      await refresh();
    } catch (err) {
      setEnsembleWeightsSaveState({ status: "error", message: err instanceof ApiRequestError ? err.message : "Failed to save weights." });
    }
  }

  async function handleSaveScreeningConfig() {
    if (!session || !screeningConfigDraft) return;
    setScreeningConfigSaveState({ status: "pending" });
    try {
      await setScreeningConfig(session.access_token, screeningConfigDraft);
      setScreeningConfigSaveState(null);
      await refresh();
    } catch (err) {
      setScreeningConfigSaveState({ status: "error", message: err instanceof ApiRequestError ? err.message : "Failed to save screening config." });
    }
  }

  async function handleSaveAccumulatorTarget(target: AccumulatorTarget) {
    if (!session) return;
    const draft = accumulatorTargetDrafts[target.legs] ?? { minSelectionScore: target.minSelectionScore, enabled: target.enabled };
    setAccumulatorTargetSaveState((prev) => ({ ...prev, [target.legs]: { status: "pending" } }));
    try {
      await setAccumulatorTarget(session.access_token, target.legs, draft.minSelectionScore, draft.enabled);
      setAccumulatorTargetSaveState((prev) => ({ ...prev, [target.legs]: null }));
      await refresh();
    } catch (err) {
      setAccumulatorTargetSaveState((prev) => ({
        ...prev,
        [target.legs]: { status: "error", message: err instanceof ApiRequestError ? err.message : "Failed to save target." }
      }));
    }
  }

  async function handleToggleAllowlist(competitionId: string, enabled: boolean) {
    if (!session) return;
    setAllowlistSaveState((prev) => ({ ...prev, [competitionId]: { status: "pending" } }));
    try {
      await setCompetitionAllowlistEntry(session.access_token, competitionId, enabled);
      setAllowlistSaveState((prev) => ({ ...prev, [competitionId]: null }));
      await refresh();
    } catch (err) {
      setAllowlistSaveState((prev) => ({
        ...prev,
        [competitionId]: { status: "error", message: err instanceof ApiRequestError ? err.message : "Failed to update allowlist." }
      }));
    }
  }

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
      const res = await fitDixonColesRho(
        session.access_token,
        `${backtestFrom}T00:00:00.000Z`,
        `${backtestTo}T23:59:59.999Z`,
        rhoCompetitionId || undefined
      );
      setFitRhoRunState(
        res.data.fittedRho === null
          ? null
          : { status: "success", fittedRho: res.data.fittedRho, sampleSize: res.data.sampleSize, competitionId: res.data.competitionId }
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
        <h2 className="mb-3 text-lg font-semibold">League calibration</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Each competition's real average home/away goals, computed from its own finished fixtures — replacing the
          fixed cross-league default used for a competition with too little real history yet. Runs daily (the
          "League calibration" button above triggers it out of cycle) and feeds every live prediction; not yet used
          by backtesting/training/rho-fitting below, which still use the fixed default for every historical fixture
          regardless of competition.
        </p>
        {data.leagueCalibrationError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.leagueCalibrationError}
          </p>
        )}
        {data.leagueCalibration && data.leagueCalibration.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No competition has enough real fixture history to calibrate yet — every prediction is using the fixed
            cross-league default.
          </p>
        )}
        {data.leagueCalibration && data.leagueCalibration.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-4 font-medium">Competition</th>
                  <th className="py-2 pr-4 font-medium">Avg home goals</th>
                  <th className="py-2 pr-4 font-medium">Avg away goals</th>
                  <th className="py-2 pr-4 font-medium">Sample size</th>
                  <th className="py-2 font-medium">Computed</th>
                </tr>
              </thead>
              <tbody>
                {data.leagueCalibration.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4">{row.competitionName ?? row.competition_id}</td>
                    <td className="py-2 pr-4">{row.league_avg_home_goals.toFixed(2)}</td>
                    <td className="py-2 pr-4">{row.league_avg_away_goals.toFixed(2)}</td>
                    <td className="py-2 pr-4">{row.sample_size}</td>
                    <td className="py-2 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(row.computed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
          <label className="flex flex-col text-xs text-slate-500 dark:text-slate-400">
            Rho competition ID (optional)
            <input
              type="text"
              value={rhoCompetitionId}
              onChange={(e) => setRhoCompetitionId(e.target.value)}
              placeholder="leave blank for a global fit"
              className="mt-1 w-56 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            />
          </label>
          <button
            type="button"
            disabled={!backtestFrom || !backtestTo || fitRhoRunState?.status === "pending"}
            onClick={() => void handleFitRho()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {fitRhoRunState?.status === "pending"
              ? "Fitting…"
              : rhoCompetitionId
                ? "Fit Dixon-Coles rho (this competition)"
                : "Fit Dixon-Coles rho (global)"}
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
            Fitted rho = {fitRhoRunState.fittedRho.toFixed(4)} from {fitRhoRunState.sampleSize} matches in range —{" "}
            {fitRhoRunState.competitionId
              ? "stored for this competition only (see the per-competition rho table below); every other competition's predictions are unaffected."
              : "now in effect for every poisson-baseline prediction that has no competition-specific fit of its own."}
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

        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">Per-competition rho fits</h3>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Competitions with their own fitted rho (via the "Competition ID" field above) — each one overrides the
            global fit above for that competition's own predictions only. Not yet used by backtesting/training,
            which still use the global fit or fixed default for every historical fixture regardless of competition.
          </p>
          {data.competitionRhoError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {data.competitionRhoError}
            </p>
          )}
          {data.competitionRho && data.competitionRho.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No competition has a rho fit of its own yet — every prediction uses the global fit or fixed default.
            </p>
          )}
          {data.competitionRho && data.competitionRho.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800">
                    <th className="py-2 pr-4 font-medium">Competition</th>
                    <th className="py-2 pr-4 font-medium">Fitted rho</th>
                    <th className="py-2 pr-4 font-medium">Sample size</th>
                    <th className="py-2 font-medium">Computed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.competitionRho.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 dark:border-slate-900">
                      <td className="py-2 pr-4">{row.competitionName ?? row.competition_id}</td>
                      <td className="py-2 pr-4">{row.fitted_rho.toFixed(4)}</td>
                      <td className="py-2 pr-4">{row.sample_size}</td>
                      <td className="py-2 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(row.computed_at)}</td>
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

      <section>
        <h2 className="mb-3 text-lg font-semibold">Admin audit log</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Every action (not read) any admin has taken through this API — who, what changed, and the result. Reads
          like the tables above never appear here; only POST/PUT/PATCH/DELETE requests do.
        </p>
        {data.auditLogError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.auditLogError}
          </p>
        )}
        {data.auditLog && data.auditLog.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No admin actions recorded yet.</p>
        )}
        {data.auditLog && data.auditLog.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Admin</th>
                  <th className="py-2 pr-4 font-medium">Method</th>
                  <th className="py-2 pr-4 font-medium">Path</th>
                  <th className="py-2 pr-4 font-medium">Result</th>
                  <th className="py-2 font-medium">Body</th>
                </tr>
              </thead>
              <tbody>
                {data.auditLog.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(entry.created_at)}</td>
                    <td className="py-2 pr-4">{entry.actor_email ?? entry.actor_id ?? "—"}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{entry.method}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{entry.path}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={entry.status_code < 400 ? "success" : "danger"}>{entry.status_code}</Badge>
                    </td>
                    <td
                      className="py-2 max-w-xs truncate text-xs text-slate-500 dark:text-slate-400"
                      title={entry.request_body ? JSON.stringify(entry.request_body) : undefined}
                    >
                      {entry.request_body ? JSON.stringify(entry.request_body) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">AI Football Analyst — ensemble weights</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          How much each available component contributes to a fixture's combined probability. A component missing
          for a given fixture (e.g. no odds synced yet) has its weight redistributed among the rest, never guessed —
          these six weights only set the *starting* proportions. Must sum to 1; not yet backtested/optimal, see
          ML_Model.md.
        </p>
        {data.ensembleWeightsError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.ensembleWeightsError}
          </p>
        )}
        {ensembleWeightsDraft && (
          <div className="max-w-xl space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {ENSEMBLE_WEIGHT_FIELDS.map((field) => (
                <label key={field.key} className="text-sm">
                  <span className="mb-1 block text-slate-500 dark:text-slate-400">{field.label}</span>
                  <input
                    type="number"
                    step={0.0001}
                    min={0}
                    value={ensembleWeightsDraft[field.key]}
                    onChange={(e) =>
                      setEnsembleWeightsDraft((prev) => (prev ? { ...prev, [field.key]: Number(e.target.value) } : prev))
                    }
                    className="w-full rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Sum: {ENSEMBLE_WEIGHT_FIELDS.reduce((sum, f) => sum + (ensembleWeightsDraft[f.key] || 0), 0).toFixed(4)}{" "}
              (must be ~1)
            </p>
            <button
              type="button"
              disabled={ensembleWeightsSaveState?.status === "pending"}
              onClick={() => void handleSaveEnsembleWeights()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {ensembleWeightsSaveState?.status === "pending" ? "Saving…" : "Save weights"}
            </button>
            {ensembleWeightsSaveState?.status === "error" && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {ensembleWeightsSaveState.message}
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">AI Football Analyst — selection score &amp; risk tiers</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          How the 0-100 selection score is blended, and the score cutoffs for each risk tier. Thresholds must be
          strictly descending (elite &gt; strong &gt; medium &gt; high risk).
        </p>
        {data.screeningConfigError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.screeningConfigError}
          </p>
        )}
        {screeningConfigDraft && (
          <div className="max-w-xl space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium">Score weights</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["ensembleConfidence", "Confidence"],
                    ["ev", "EV"],
                    ["consensus", "Consensus"],
                    ["dataQuality", "Data quality"]
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="text-sm">
                    <span className="mb-1 block text-slate-500 dark:text-slate-400">{label}</span>
                    <input
                      type="number"
                      step={0.01}
                      min={0}
                      value={screeningConfigDraft.scoreWeights[key]}
                      onChange={(e) =>
                        setScreeningConfigDraft((prev) =>
                          prev ? { ...prev, scoreWeights: { ...prev.scoreWeights, [key]: Number(e.target.value) } } : prev
                        )
                      }
                      className="w-full rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">Risk tier score cutoffs (minimum to qualify)</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["eliteMin", "Elite"],
                    ["strongMin", "Strong"],
                    ["mediumMin", "Medium"],
                    ["highRiskMin", "High risk"]
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="text-sm">
                    <span className="mb-1 block text-slate-500 dark:text-slate-400">{label}</span>
                    <input
                      type="number"
                      step={1}
                      min={0}
                      max={100}
                      value={screeningConfigDraft.riskThresholds[key]}
                      onChange={(e) =>
                        setScreeningConfigDraft((prev) =>
                          prev ? { ...prev, riskThresholds: { ...prev.riskThresholds, [key]: Number(e.target.value) } } : prev
                        )
                      }
                      className="w-full rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                    />
                  </label>
                ))}
              </div>
            </div>
            <button
              type="button"
              disabled={screeningConfigSaveState?.status === "pending"}
              onClick={() => void handleSaveScreeningConfig()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {screeningConfigSaveState?.status === "pending" ? "Saving…" : "Save score config"}
            </button>
            {screeningConfigSaveState?.status === "error" && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {screeningConfigSaveState.message}
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">AI Football Analyst — accumulator targets</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Target combined-odds bands the accumulator optimizer builds toward, and the minimum selection score a leg
          needs to be eligible for each. A target never gets a weak leg added just to hit its odds figure — see
          Task.md.
        </p>
        {data.accumulatorTargetsError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.accumulatorTargetsError}
          </p>
        )}
        {data.accumulatorTargets && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-4 font-medium">Legs (~odds)</th>
                  <th className="py-2 pr-4 font-medium">Min selection score</th>
                  <th className="py-2 pr-4 font-medium">Enabled</th>
                  <th className="py-2 font-medium">Save</th>
                </tr>
              </thead>
              <tbody>
                {data.accumulatorTargets.map((target) => {
                  const draft = accumulatorTargetDrafts[target.legs] ?? {
                    minSelectionScore: target.minSelectionScore,
                    enabled: target.enabled
                  };
                  const saveState = accumulatorTargetSaveState[target.legs];
                  return (
                    <tr key={target.legs} className="border-b border-slate-100 dark:border-slate-900">
                      <td className="py-2 pr-4">ACCA {target.legs}</td>
                      <td className="py-2 pr-4">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={draft.minSelectionScore}
                          onChange={(e) =>
                            setAccumulatorTargetDrafts((prev) => ({
                              ...prev,
                              [target.legs]: { ...draft, minSelectionScore: Number(e.target.value) }
                            }))
                          }
                          className="w-20 rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(e) =>
                            setAccumulatorTargetDrafts((prev) => ({ ...prev, [target.legs]: { ...draft, enabled: e.target.checked } }))
                          }
                        />
                      </td>
                      <td className="py-2">
                        <button
                          type="button"
                          disabled={saveState?.status === "pending"}
                          onClick={() => void handleSaveAccumulatorTarget(target)}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                        >
                          {saveState?.status === "pending" ? "Saving…" : "Save"}
                        </button>
                        {saveState?.status === "error" && (
                          <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                            {saveState.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">AI Football Analyst — competition allowlist</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Which competitions the Top 20 / accumulator engine may draw fixtures from. Empty means nothing is
          screened yet — the engine never falls back to "everything unfiltered."
        </p>
        {data.leaguesError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.leaguesError}
          </p>
        )}
        {data.competitionAllowlistError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {data.competitionAllowlistError}
          </p>
        )}
        {data.leagues && data.leagues.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No competitions exist yet — run a fixtures sync first.
          </p>
        )}
        {data.leagues && data.leagues.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-4 font-medium">Competition</th>
                  <th className="py-2 font-medium">Allowlisted</th>
                </tr>
              </thead>
              <tbody>
                {data.leagues.map((league) => {
                  const entry = data.competitionAllowlist?.find((e) => e.competitionId === league.id);
                  const enabled = entry?.enabled ?? false;
                  const saveState = allowlistSaveState[league.id];
                  return (
                    <tr key={league.id} className="border-b border-slate-100 dark:border-slate-900">
                      <td className="py-2 pr-4">{league.name}</td>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={saveState?.status === "pending"}
                          onChange={(e) => void handleToggleAllowlist(league.id, e.target.checked)}
                        />
                        {saveState?.status === "error" && (
                          <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                            {saveState.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
