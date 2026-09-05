export interface TeamStrengthInput {
  matchesPlayed: number;
  goalsScoredAvg: number;
  goalsConcededAvg: number;
}

export interface PlayerCandidateInput {
  name: string;
  goalsScored: number;
  matchesPlayed: number;
}

export interface PoissonPredictionRequest {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
  leagueAvgHomeGoals: number;
  leagueAvgAwayGoals: number;
  // Optional per-request override of the Dixon-Coles rho used for this one
  // prediction — the fixture's own competition-specific fitted rho
  // (fitDixonColesRho.ts::getCompetitionRho), when one exists. Omitted
  // (not sent at all) when the competition has no per-competition fit yet,
  // letting ml-service fall back to its own existing global-fit-or-default
  // chain rather than this client re-implementing that fallback.
  rho?: number;
  // Optional — the ml-service only predicts total_cards/total_corners when
  // both of a pair are present (see main.py). Omitted, not sent as 0, when
  // this team's team_statistics row doesn't have the underlying data yet.
  homeTeamAvgYellowCards?: number;
  awayTeamAvgYellowCards?: number;
  homeTeamAvgCorners?: number;
  awayTeamAvgCorners?: number;
  // Optional, per side independently (unlike the cards/corners pairs above)
  // — the ml-service only builds a side's anytime-goalscorer market when
  // its own list is present, regardless of what the other side sent.
  homeTeamPlayers?: PlayerCandidateInput[];
  awayTeamPlayers?: PlayerCandidateInput[];
}

export interface MarketProbability {
  market: string;
  selection: string;
  probability: number;
  factors: { direction: "positive" | "negative"; label: string }[];
}

export interface PoissonPredictionResponse {
  modelName: string;
  modelVersion: string;
  dataQuality: "insufficient" | "limited" | "strong";
  predictions: MarketProbability[];
}

// Second model on the wishlist (Task.md) — 1x2 only, see
// ml-service/app/models/gradient_boosting.py. Reuses TeamStrengthInput; no
// league-average/cards/corners/player fields, since this model doesn't use
// them.
export interface GradientBoostingPredictRequest {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
}

export type OneXTwoOutcome = "home" | "draw" | "away";

// --- AI Football Analyst (Phase 1): Elo + ensemble ---

export interface TeamEloInput {
  rating: number;
  matchesPlayed: number;
}

export interface EloPredictionRequest {
  homeTeam: TeamEloInput;
  awayTeam: TeamEloInput;
}

// Same shape as PoissonPredictionResponse (1x2 only) — reused rather than
// declaring a parallel type, same reasoning as GradientBoostingPredictionResponse.

export interface EnsembleComponentInput {
  home: number;
  draw: number;
  away: number;
}

export interface EnsembleWeightsInput {
  elo: number;
  poisson: number;
  form: number;
  homeAway: number;
  injuries: number;
  market: number;
}

export interface ScoreWeightsInput {
  ensembleConfidence: number;
  ev: number;
  consensus: number;
  dataQuality: number;
}

export interface RiskThresholdsInput {
  eliteMin: number;
  strongMin: number;
  mediumMin: number;
  highRiskMin: number;
}

export interface EnsemblePredictRequest {
  // Keys are a subset of {"poisson", "elo", "form", "homeAway"} — market
  // and injuries are derived by ml-service itself from decimalOdds/
  // homeKeyAbsences+awayKeyAbsences below, not sent as pre-computed
  // triples (see ensemble.py's module docstring).
  components: Record<string, EnsembleComponentInput>;
  // Same keys as components — the data_quality each individual call
  // reported for itself (e.g. a PoissonPredictionResponse's own dataQuality).
  componentDataQuality: Record<string, "insufficient" | "limited" | "strong">;
  weights: EnsembleWeightsInput;
  scoreWeights: ScoreWeightsInput;
  riskThresholds: RiskThresholdsInput;
  // 1x2 only in Phase 1. Omitted (not sent as zeros) when odds coverage is
  // missing/stale for this fixture — never fabricated.
  decimalOdds?: { home: number; draw: number; away: number };
  homeKeyAbsences?: number;
  awayKeyAbsences?: number;
}

export interface EnsembleSelectionResult {
  selection: OneXTwoOutcome;
  probability: number;
  ev: number | null;
  edgePct: number | null;
  selectionScore: number;
  riskTier: "elite" | "strong" | "medium" | "high_risk" | "avoid";
  factors: { direction: "positive" | "negative"; label: string }[];
}

export interface EnsemblePredictResponse {
  modelName: string;
  modelVersion: string;
  market: string;
  dataQuality: "insufficient" | "limited" | "strong";
  consensusLevel: "high" | "moderate" | "low" | "conflicting";
  componentWeightsUsed: Record<string, number>;
  missingComponents: string[];
  selections: EnsembleSelectionResult[];
}

export interface GradientBoostingTrainingRow {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
  outcome: OneXTwoOutcome;
}

export interface GradientBoostingTrainRequest {
  rows: GradientBoostingTrainingRow[];
}

export interface GradientBoostingTrainResult {
  sampleSize: number;
  // In-sample only — see gradient_boosting.py's TrainingResult docstring.
  // Never present this as a generalization/held-out metric.
  trainAccuracy: number;
  classCounts: Record<string, number>;
}

// Fitting the Dixon-Coles RHO parameter (Task.md wishlist) — see
// ml-service/app/models/rho_fitting.py. One row per historical match;
// leagueAvgHomeGoals/leagueAvgAwayGoals are shared across the whole
// request (this platform always uses one fixed pair, never per-fixture
// values — see generatePredictions.ts), so ml-service can derive each
// row's lambda_home/lambda_away itself via the same expected_goals()
// formula /predict/poisson uses.
export interface DixonColesRhoFitRow {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
  actualHomeGoals: number;
  actualAwayGoals: number;
}

export interface DixonColesRhoFitRequest {
  leagueAvgHomeGoals: number;
  leagueAvgAwayGoals: number;
  rows: DixonColesRhoFitRow[];
  // True (the default) adopts this fit as ml-service's process-wide
  // fallback rho, same as every fit before per-competition fitting
  // existed. False fits and returns the result without touching that
  // fallback — used for a competition-scoped fit, whose result gets
  // stored in competition_rho instead of overwriting the one value every
  // other competition's predictions would otherwise fall back to.
  applyGlobally?: boolean;
}

export interface DixonColesRhoFitResult {
  sampleSize: number;
  informativeMatches: number;
  fittedRho: number;
  logLikelihoodAtFittedRho: number;
  logLikelihoodAtDefaultRho: number;
  defaultRho: number;
}

export interface RhoStatus {
  fittedRho: number | null;
  defaultRho: number;
}

// Thin HTTP client for the Python ML service. Kept separate from route
// handlers so the timeout/error-mapping policy lives in exactly one place.
export class PredictionClient {
  // Defaults from process.env rather than being threaded through every
  // caller's constructor args — every one of this class's ~10 call sites
  // across the job files already just forwards a bare mlServiceUrl string
  // with no other per-call config, so this is a single-file fix for
  // ml-service/app/security.py's auth requirement instead of adding a new
  // parameter to every function between here and config/env.ts. Explicit
  // apiKey still wins when a caller does pass one (tests do, to avoid
  // depending on process.env). Unset (the default) sends no header at all,
  // matching ml-service's own "no configured key means no enforcement".
  private readonly apiKey?: string;

  constructor(private readonly baseUrl: string, apiKey?: string, private readonly timeoutMs = 5000) {
    this.apiKey = apiKey ?? process.env.ML_SERVICE_API_KEY;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    return headers;
  }

  async predictPoisson(payload: PoissonPredictionRequest): Promise<PoissonPredictionResponse | null> {
    return this.predictOrNull<PoissonPredictionResponse>("/predict/poisson", payload);
  }

  // Same null-on-any-failure contract as predictPoisson, including the
  // ml-service's 409 "not trained yet" response — the caller (backtest
  // scoring, live predictions) treats "no result" as "skip this one",
  // never fabricates a fallback probability.
  async predictGradientBoosting(payload: GradientBoostingPredictRequest): Promise<PoissonPredictionResponse | null> {
    return this.predictOrNull<PoissonPredictionResponse>("/predict/gradient_boosting", payload);
  }

  // Same null-on-any-failure contract as predictPoisson/predictGradientBoosting.
  async predictElo(payload: EloPredictionRequest): Promise<PoissonPredictionResponse | null> {
    return this.predictOrNull<PoissonPredictionResponse>("/predict/elo", payload);
  }

  // Same contract — a missing/failed ensemble call means "skip this
  // fixture", never a fabricated combined probability.
  async predictEnsemble(payload: EnsemblePredictRequest): Promise<EnsemblePredictResponse | null> {
    return this.predictOrNull<EnsemblePredictResponse>("/predict/ensemble", payload);
  }

  private async predictOrNull<T>(path: string, payload: unknown): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      // Network error, timeout, or malformed response — caller treats a
      // null result as "prediction unavailable", never fabricates one.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unlike predictions, a training failure is rare and actionable (e.g. too
  // few rows, or a single-outcome dataset — see gradient_boosting.py) — so
  // this throws with the ml-service's own detail message rather than
  // swallowing to null, letting the admin route surface exactly why
  // training didn't happen.
  async trainGradientBoosting(payload: GradientBoostingTrainRequest): Promise<GradientBoostingTrainResult> {
    // Training a few hundred rows of gradient boosting is more expensive
    // than a single prediction — give it more room before giving up.
    return this.postJsonThrowing("/train/gradient_boosting", payload, this.timeoutMs * 6);
  }

  // Same "throw with ml-service's own detail message" contract as
  // trainGradientBoosting — a fit failure (e.g. too few matches finishing
  // 0-0/1-0/0-1/1-1 — see rho_fitting.py) is rare and actionable, not
  // something to silently skip.
  async fitDixonColesRho(payload: DixonColesRhoFitRequest): Promise<DixonColesRhoFitResult> {
    return this.postJsonThrowing("/fit/dixon_coles_rho", payload, this.timeoutMs * 6);
  }

  async getRhoStatus(): Promise<RhoStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/rho_status`, { headers: this.requestHeaders(), signal: controller.signal });
      if (!res.ok) throw new Error(`rho_status request failed with status ${res.status}`);
      return (await res.json()) as RhoStatus;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postJsonThrowing<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(body?.detail ?? `Request to ${path} failed with status ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
