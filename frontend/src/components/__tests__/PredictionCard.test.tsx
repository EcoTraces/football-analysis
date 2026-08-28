import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PredictionCard } from "../PredictionCard";
import type { PredictionView } from "../../lib/types";

const predictions: PredictionView[] = [
  {
    market: "1x2",
    selection: "home",
    probability: 0.55,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: "moderate",
    factors: [{ direction: "positive", label: "Strong home form" }],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "1x2",
    selection: "draw",
    probability: 0.25,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: null,
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "double_chance",
    selection: "home_or_draw",
    probability: 0.8,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: "low",
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "correct_score",
    selection: "2-1",
    probability: 0.12,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: "high",
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "correct_score",
    selection: "other",
    probability: 0.4,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: null,
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "total_cards",
    selection: "over",
    probability: 0.62,
    confidence: "low",
    dataQuality: "limited",
    riskClassification: "moderate",
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "half_with_most_goals",
    selection: "second_half",
    probability: 0.48,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: "moderate",
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  },
  {
    market: "half_with_most_goals",
    selection: "equal",
    probability: 0.24,
    confidence: "medium",
    dataQuality: "limited",
    riskClassification: null,
    factors: [],
    modelVersionId: "v1",
    generatedAt: new Date().toISOString(),
    freshness: "LIVE"
  }
];

describe("PredictionCard", () => {
  it("renders probability as a percentage, not a bare decimal", () => {
    render(<PredictionCard predictions={predictions} market="1x2" />);
    expect(screen.getByText("55%")).toBeTruthy();
  });

  it("never states a probability without its confidence and data quality alongside it", () => {
    render(<PredictionCard predictions={predictions} market="1x2" />);
    expect(screen.getByText(/Medium confidence/)).toBeTruthy();
    expect(screen.getByText(/Limited data/)).toBeTruthy();
  });

  it("renders nothing when the market has no predictions, rather than a misleading empty card", () => {
    const { container } = render(<PredictionCard predictions={predictions} market="btts" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders double chance with a human-readable selection label, not a raw enum value", () => {
    render(<PredictionCard predictions={predictions} market="double_chance" />);
    expect(screen.getByText("Double chance")).toBeTruthy();
    expect(screen.getByText("Home or draw (1X)")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
  });

  it("renders correct score scorelines as-is and labels the catch-all bucket", () => {
    render(<PredictionCard predictions={predictions} market="correct_score" />);
    expect(screen.getByText("Correct score")).toBeTruthy();
    expect(screen.getByText("2-1")).toBeTruthy();
    expect(screen.getByText("Other scoreline")).toBeTruthy();
  });

  it("sorts selections by probability descending, keeping 'other' last regardless of its own probability", () => {
    render(<PredictionCard predictions={predictions} market="correct_score" />);
    const rowLabels = screen.getAllByText(/^(2-1|Other scoreline)$/).map((el) => el.textContent);
    // "other" has the higher probability (0.4 vs 0.12) but must still sort last.
    expect(rowLabels).toEqual(["2-1", "Other scoreline"]);
  });

  it("renders total cards with its over/under line in the market label", () => {
    render(<PredictionCard predictions={predictions} market="total_cards" />);
    expect(screen.getByText("Total cards (O/U 3.5)")).toBeTruthy();
    expect(screen.getByText("62%")).toBeTruthy();
  });

  it("renders nothing for total corners when the fixture has no such prediction yet", () => {
    // Matches how the real data looks before both teams have corners
    // synced — the market simply doesn't appear in the fixture's predictions.
    const { container } = render(<PredictionCard predictions={predictions} market="total_corners" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders half-with-most-goals with human-readable labels for both halves", () => {
    render(<PredictionCard predictions={predictions} market="half_with_most_goals" />);
    expect(screen.getByText("Half with most goals")).toBeTruthy();
    expect(screen.getByText("Second half")).toBeTruthy();
    expect(screen.getByText("48%")).toBeTruthy();
    // "equal" has no explicit label mapping — falls back to capitalize.
    expect(screen.getByText("equal")).toBeTruthy();
  });

  it("renders nothing for first-half result when the fixture has no such prediction", () => {
    const { container } = render(<PredictionCard predictions={predictions} market="first_half_result" />);
    expect(container.innerHTML).toBe("");
  });
});
