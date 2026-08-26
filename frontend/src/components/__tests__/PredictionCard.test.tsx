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
});
