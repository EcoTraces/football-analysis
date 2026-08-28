import type { PredictionView } from "../lib/types";
import { FreshnessBadge } from "./FreshnessBadge";

const MARKET_LABELS: Record<string, string> = {
  "1x2": "Match result",
  btts: "Both teams to score",
  over_under_2_5: "Over/under 2.5 goals",
  double_chance: "Double chance",
  correct_score: "Correct score"
};

// Selections not listed here (home/draw/away/yes/no/over/under, and
// correct_score's own "2-1"-style scorelines) fall back to the raw
// selection string with CSS capitalize, which already reads fine for them.
const SELECTION_LABELS: Record<string, string> = {
  home_or_draw: "Home or draw (1X)",
  home_or_away: "Home or away (12)",
  draw_or_away: "Draw or away (X2)",
  other: "Other scoreline"
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

// Groups the flat prediction list by market so each card reads as one
// question ("who wins?") with all its selections, per spec section 21.
export function PredictionCard({ predictions, market }: { predictions: PredictionView[]; market: string }) {
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

  return (
    <section className="rounded-lg border border-slate-200 p-4 dark:border-slate-800" aria-label={MARKET_LABELS[market] ?? market}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{MARKET_LABELS[market] ?? market}</h3>
        <FreshnessBadge freshness={primary.freshness} />
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.selection} className="flex items-center justify-between text-sm">
            <span className={SELECTION_LABELS[row.selection] ? undefined : "capitalize"}>
              {SELECTION_LABELS[row.selection] ?? row.selection}
            </span>
            <span className="font-mono">{`${(row.probability * 100).toFixed(0)}%`}</span>
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
