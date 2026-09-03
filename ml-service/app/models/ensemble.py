"""Ensemble combiner for the AI Football Analyst engine (Phase 1).

Combines several already-computed 3-way (home/draw/away) probability
triples into one calibrated probability, plus the derived selection score
and risk tier used by the Top 20 screening engine. This module is purely
stateless math over whatever the caller (backend/src/jobs/
generateEnsemblePredictions.ts) supplies — it never fetches data itself and
never fabricates a missing component's value.

Six possible components: elo, poisson, form, home_away (each a 3-way
probability triple computed elsewhere — elo.py's /predict/elo, or
poisson.py's /predict/poisson called with different inputs for poisson,
form, and home_away), plus market and injuries, which THIS module derives
directly from raw bookmaker odds / key-absence counts (see
devig_market_probabilities/injury_adjustment) rather than receiving as a
pre-computed triple, since neither has its own standalone prediction
endpoint.

Every constant below (MAX_DRAW_PROBABILITY-style fixed approximations,
scoring scales) is a documented placeholder, not a fitted value — same
"plausible, not backtested" honesty as poisson.py's RHO and elo.py's
HOME_ADVANTAGE. Weights themselves are NOT constants here; they are
supplied per-call from ensemble_config/screening_config (admin-editable —
see backend/src/services/adminConfigService.ts), specifically so they can
be tuned/backtested later without a code change.
"""

OUTCOMES = ("home", "draw", "away")

CONSENSUS_SCORE = {"high": 100.0, "moderate": 65.0, "low": 35.0, "conflicting": 0.0}
DATA_QUALITY_SCORE = {"strong": 100.0, "limited": 55.0, "insufficient": 0.0}
DATA_QUALITY_RANK = {"insufficient": 0, "limited": 1, "strong": 2}  # lower rank = worse quality

KEY_ABSENCE_IMPACT = 0.04  # Probability shifted per net key absence.
MAX_ABSENCE_SHIFT = 0.15  # Cap, so a heavily depleted side is never driven near-zero by this signal alone.

EV_SCORE_SCALE = 0.20  # EV of +/-20% maps to the 100/0 ends of ev_score's range.


def combine_components(
    component_probabilities: dict[str, dict[str, float]], weights: dict[str, float]
) -> tuple[dict[str, float], dict[str, float]]:
    """Weighted-average of whichever components are actually present.

    Returns (combined_probabilities, weights_used). weights_used holds each
    present component's weight AFTER redistributing the weight of any
    missing component proportionally — never guessing a value for a
    component that wasn't supplied. Because every component triple already
    sums to 1 and weights_used itself sums to 1, the result is always a
    valid probability distribution with no separate renormalization step
    needed.
    """
    present = {name: probs for name, probs in component_probabilities.items() if name in weights}
    if not present:
        raise ValueError("No ensemble components available for this fixture")

    total_weight = sum(weights[name] for name in present)
    if total_weight <= 0:
        raise ValueError("Present ensemble components have zero total configured weight")

    weights_used = {name: weights[name] / total_weight for name in present}

    combined = {outcome: 0.0 for outcome in OUTCOMES}
    for name, probs in present.items():
        w = weights_used[name]
        for outcome in OUTCOMES:
            combined[outcome] += w * probs[outcome]
    return combined, weights_used


def devig_market_probabilities(decimal_odds: dict[str, float]) -> dict[str, float]:
    """Converts bookmaker decimal odds into normalized ("de-vigged")
    implied probabilities for the Market ensemble component — divides out
    the bookmaker's overround (implied probabilities always sum to
    slightly over 1 before this) rather than treating raw 1/odds as a
    calibrated probability."""
    if any(decimal_odds.get(outcome, 0) <= 0 for outcome in OUTCOMES):
        raise ValueError("Degenerate odds input — every selection needs decimal odds > 0")
    implied = {outcome: 1.0 / decimal_odds[outcome] for outcome in OUTCOMES}
    return {outcome: value / sum(implied.values()) for outcome, value in implied.items()}


def injury_adjustment(home_key_absences: int, away_key_absences: int) -> dict[str, float]:
    """A small, explicitly-unvalidated symmetric nudge for the Injuries
    ensemble component (see backend's getKeyAbsences — an "above-team-
    median goalscorer, currently injured/suspended/doubtful" proxy, gated
    on data freshness before this is ever called). Starts from an even
    1/3-1/3-1/3 prior — this component has no independent opinion on the
    baseline matchup, only on the marginal effect of who's missing — and
    shifts home/away symmetrically around it based on the net difference
    in key absences, capped so a depleted side is never driven to a
    near-zero share from this signal alone.
    """
    net_shift = (away_key_absences - home_key_absences) * KEY_ABSENCE_IMPACT
    net_shift = max(-MAX_ABSENCE_SHIFT, min(MAX_ABSENCE_SHIFT, net_shift))
    return {"home": 1 / 3 + net_shift, "draw": 1 / 3, "away": 1 / 3 - net_shift}


def consensus_level(component_probabilities: dict[str, dict[str, float]], combined: dict[str, float]) -> str:
    """How strongly the present components agree with each other, not just
    with the combined result — spec section 15's "model agreement" concept.

    Two components (or one) can't demonstrate "agreement" in any
    meaningful sense, so that case is reported as "low" rather than "high"
    regardless of how confident the single component is. Otherwise: if
    components don't even share the same favoured outcome, this is at best
    "moderate" (or "conflicting" if the spread on the combined favourite is
    also wide); if they do share a favourite, agreement is graded by how
    tightly clustered their probabilities for that outcome are.
    """
    if len(component_probabilities) < 2:
        return "low"

    favourite = max(combined, key=lambda outcome: combined[outcome])
    individual_picks = {max(probs, key=lambda outcome: probs[outcome]) for probs in component_probabilities.values()}
    values_for_favourite = [probs[favourite] for probs in component_probabilities.values()]
    spread = max(values_for_favourite) - min(values_for_favourite)

    if len(individual_picks) > 1:
        return "conflicting" if spread > 0.35 else "moderate"
    if spread <= 0.10:
        return "high"
    if spread <= 0.20:
        return "moderate"
    return "low"


def overall_data_quality(component_data_quality: dict[str, str]) -> str:
    """The ensemble's overall data quality is the WORST quality among the
    components actually used, never the best — a single strong component
    can't paper over another component built from too little data."""
    if not component_data_quality:
        raise ValueError("No component data-quality values supplied")
    return min(component_data_quality.values(), key=lambda quality: DATA_QUALITY_RANK[quality])


def compute_ev_and_edge(probability: float, decimal_odds: float | None) -> tuple[float | None, float | None]:
    """EV and edge-percentage for one selection against one real
    bookmaker price. Returns (None, None) when no real odds were supplied
    — this must never invent an odds figure (spec: "Never fabricate odds.
    If live odds are unavailable, explicitly display 'Odds unavailable.'").
    """
    if decimal_odds is None:
        return None, None
    implied_probability = 1.0 / decimal_odds
    edge_pct = (probability - implied_probability) * 100
    ev = probability * decimal_odds - 1
    return ev, edge_pct


def selection_score(
    probability: float,
    ev: float | None,
    consensus: str,
    data_quality: str,
    score_weights: dict[str, float],
) -> float:
    """0-100 score blending the four signals this platform can actually
    compute (see screening_config's column comment for why this is 4
    inputs, not the original spec's fuller 7-component breakdown — the
    others need data, e.g. xG-based "statistical strength" or tactical
    matchup data, this platform doesn't have).

    ev=None (no real odds available for this selection) maps to a neutral
    50, never a bonus or a penalty — a selection must not be scored better
    or worse purely for having/lacking odds coverage.
    """
    confidence_score = max(0.0, min(100.0, probability * 100))
    ev_score = 50.0 if ev is None else max(0.0, min(100.0, 50 + (ev / EV_SCORE_SCALE) * 50))
    consensus_score = CONSENSUS_SCORE[consensus]
    quality_score = DATA_QUALITY_SCORE[data_quality]

    score = (
        score_weights["ensemble_confidence"] * confidence_score
        + score_weights["ev"] * ev_score
        + score_weights["consensus"] * consensus_score
        + score_weights["data_quality"] * quality_score
    )
    return max(0.0, min(100.0, score))


def risk_tier(score: float, thresholds: dict[str, float]) -> str:
    """Maps a 0-100 selection score onto the platform's 5-tier scheme.
    Thresholds are admin-editable (screening_config); the ordering
    elite > strong > medium > high_risk > avoid is fixed."""
    if score >= thresholds["elite_min"]:
        return "elite"
    if score >= thresholds["strong_min"]:
        return "strong"
    if score >= thresholds["medium_min"]:
        return "medium"
    if score >= thresholds["high_risk_min"]:
        return "high_risk"
    return "avoid"


def explain_factors(consensus: str, missing_components: list[str]) -> list[dict[str, str]]:
    """Caveats derived only from what this module itself computed —
    missing components and model (dis)agreement. These apply identically
    regardless of which selection (home/draw/away) they're attached to, so
    (unlike poisson.py/elo.py's directional factors) there is no home/away
    flip logic needed here.
    """
    factors: list[dict[str, str]] = []

    if missing_components:
        factors.append(
            {
                "direction": "negative",
                "label": f"Ensemble components unavailable for this fixture: {', '.join(sorted(missing_components))}",
                "kind": "caveat",
            }
        )

    if consensus in ("low", "conflicting"):
        factors.append(
            {
                "direction": "negative",
                "label": "Available models show meaningful disagreement on the likely outcome",
                "kind": "caveat",
            }
        )

    return factors
