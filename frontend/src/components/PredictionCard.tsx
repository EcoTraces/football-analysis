import type { PredictionView } from "../lib/types";
import { FreshnessBadge } from "./FreshnessBadge";

const MARKET_LABELS: Record<string, string> = {
  "1x2": "Match result",
  btts: "Both teams to score",
  over_under_2_5: "Over/under 2.5 goals",
  double_chance: "Double chance",
  correct_score: "Correct score",
  total_cards: "Total cards (O/U 3.5)",
  total_corners: "Total corners (O/U 9.5)",
  first_half_result: "First-half result",
  second_half_result: "Second-half result",
  half_with_most_goals: "Half with most goals",
  home_anytime_goalscorer: "Anytime goalscorer — home team",
  away_anytime_goalscorer: "Anytime goalscorer — away team",
  home_clean_sheet: "Clean sheet — home team",
  away_clean_sheet: "Clean sheet — away team",
  odd_even_goals: "Odd/even total goals",
  draw_no_bet: "Draw no bet",
  handicap: "Handicap (Home -1.5)",
  home_team_total_goals: "Home team goals (O/U 1.5)",
  away_team_total_goals: "Away team goals (O/U 1.5)",
  home_wins_a_half: "Home team wins a half",
  away_wins_a_half: "Away team wins a half",
  btts_and_result: "Both teams to score & result",
  result_and_total_goals: "Result & total goals (2.5)"
};

// These two markets' selections are player names (free text from
// player_statistics.player_name), not an enum — CSS capitalize would
// mangle a real name like "de Bruyne" into "De Bruyne", so they're
// rendered as-is rather than through the enum-label styling below.
const FREE_TEXT_SELECTION_MARKETS = new Set(["home_anytime_goalscorer", "away_anytime_goalscorer"]);

// Selections not listed here (home/draw/away/yes/no/over/under, and
// correct_score's own "2-1"-style scorelines) fall back to the raw
// selection string with CSS capitalize, which already reads fine for them.
const SELECTION_LABELS: Record<string, string> = {
  home: "Home win",
  draw: "Draw",
  away: "Away win",
  home_or_draw: "Home or draw (1X)",
  home_or_away: "Home or away (12)",
  draw_or_away: "Draw or away (X2)",
  other: "Other scoreline",
  first_half: "First half",
  second_half: "Second half",
  // btts_and_result
  yes_home: "BTTS & home win",
  yes_draw: "BTTS & draw",
  yes_away: "BTTS & away win",
  no_home: "No BTTS & home win",
  no_draw: "No BTTS & draw",
  no_away: "No BTTS & away win",
  // result_and_total_goals
  home_over: "Home win & over 2.5",
  home_under: "Home win & under 2.5",
  draw_over: "Draw & over 2.5",
  draw_under: "Draw & under 2.5",
  away_over: "Away win & over 2.5",
  away_under: "Away win & under 2.5"
};

const CONFIDENCE_LABELS: Record<PredictionView["confidence"], string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence"
};

const DATA_QUALITY_LABELS: Record<PredictionView["dataQuality"], string> = {
  insufficient: "Insufficient data",
  limited: "Limited data",
  strong: "Strong data"
};

// "primary" is used once per match (the 1x2 market) to give the headline
// prediction visual weight before the other ~20 markets; "secondary" (the
// default) is the compact form used everywhere else. Same component, same
// data contract — only presentation changes, per the "one reusable
// component, not a near-duplicate" rule.
export function PredictionCard({
  predictions,
  market,
  variant = "secondary"
}: {
  predictions: PredictionView[];
  market: string;
  variant?: "primary" | "secondary";
}) {
  // Sorted by probability descending so the most likely selection leads —
  // matters most for correct_score, which has 11 rows; "other" always
  // sorts last regardless of its probability, since it's a catch-all bucket
  // rather than a specific outcome.
  const rows = predictions
    .filter((p) => p.market === market)
    .sort((a, b) => {
      if (a.selection === "other") return 1;
      if (b.selection === "other") return -1;
      return b.probability - a.probability;
    });
  const primary = rows[0];
  if (!primary) return null;

  if (variant === "primary") {
    const rest = rows.slice(1);
    return (
      <section
        className="rounded-xl border border-pitch-200 bg-pitch-50/60 p-5 dark:border-pitch-800 dark:bg-pitch-950/30"
        aria-label={MARKET_LABELS[market] ?? market}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-pitch-800 dark:text-pitch-200">
            Model prediction — {MARKET_LABELS[market] ?? market}
          </h2>
          <FreshnessBadge freshness={primary.freshness} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-2xl font-bold tracking-tight">
            {SELECTION_LABELS[primary.selection] ?? primary.selection}
          </p>
          <p className="font-mono text-3xl font-bold tabular-nums text-pitch-700 dark:text-pitch-300">
            {`${(primary.probability * 100).toFixed(0)}%`}
          </p>
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {CONFIDENCE_LABELS[primary.confidence]} · {DATA_QUALITY_LABELS[primary.dataQuality]}
        </p>
        {primary.factors.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {primary.factors.map((factor) => (
              <li key={factor.label} className={factor.direction === "positive" ? "text-pitch-700 dark:text-pitch-300" : "text-red-600 dark:text-red-400"}>
                {factor.direction === "positive" ? "+ " : "− "}
                {factor.label}
              </li>
            ))}
          </ul>
        )}
        {rest.length > 0 && (
          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-pitch-200 pt-3 text-sm dark:border-pitch-800">
            {rest.map((row) => (
              <div key={row.selection} className="flex items-baseline gap-1.5">
                <dt className="text-slate-500 dark:text-slate-400">{SELECTION_LABELS[row.selection] ?? row.selection}</dt>
                <dd className="font-mono tabular-nums">{`${(row.probability * 100).toFixed(0)}%`}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-800" aria-label={MARKET_LABELS[market] ?? market}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{MARKET_LABELS[market] ?? market}</h3>
        <FreshnessBadge freshness={primary.freshness} />
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.selection} className="flex items-center justify-between text-sm">
            <span className={SELECTION_LABELS[row.selection] || FREE_TEXT_SELECTION_MARKETS.has(market) ? undefined : "capitalize"}>
              {SELECTION_LABELS[row.selection] ?? row.selection}
            </span>
            <span className="font-mono tabular-nums">{`${(row.probability * 100).toFixed(0)}%`}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {CONFIDENCE_LABELS[primary.confidence]} · {DATA_QUALITY_LABELS[primary.dataQuality]}
      </p>
      {primary.factors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {primary.factors.map((factor) => (
            <li key={factor.label} className={factor.direction === "positive" ? "text-pitch-600" : "text-red-600"}>
              {factor.direction === "positive" ? "+ " : "− "}
              {factor.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
