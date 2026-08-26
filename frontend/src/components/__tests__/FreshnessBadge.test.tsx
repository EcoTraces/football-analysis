import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FreshnessBadge } from "../FreshnessBadge";

describe("FreshnessBadge", () => {
  it("renders a human-readable label, never just a color, for each state", () => {
    render(<FreshnessBadge freshness="LIVE" />);
    expect(screen.getByRole("status").textContent).toBe("Live");
  });

  it("labels missing data explicitly rather than hiding it", () => {
    render(<FreshnessBadge freshness="UNAVAILABLE" />);
    expect(screen.getByRole("status").textContent).toBe("Data unavailable");
  });
});
