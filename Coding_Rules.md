# Coding Rules

## No Fake Data Rule (highest priority)

- Never fabricate fixtures, results, injuries, suspensions, lineups, odds,
  standings, statistics, weather, predictions, or model performance.
- If a data source isn't configured or a provider call fails, return an
  explicit "unavailable" result (`ProviderResponse` with `ok: false`) and
  let the UI show "Data unavailable." Never fall back to a plausible guess.
- Mock/synthetic data is allowed only under `/mock`-equivalent, clearly
  named locations (`supabase/seed/dev_seed_synthetic.sql`) with an
  `is_synthetic = true` flag, and every production read path must filter it
  out by default. Never let synthetic data become the "path of least
  resistance" for making a feature look done.
- Do not backfill "realistic-looking" historical results, injuries, or
  odds from training data/memory — if it isn't sourced from a real,
  attributed provider, it doesn't go in the database.

## Language rules

Never use "100% sure," "guaranteed win," "fixed match," "banker," or
"risk-free" anywhere — code, copy, docs, or commit messages. Use
"probability," "confidence," "data quality," and "risk classification"
instead. Every surface showing predictions carries responsible-gambling
messaging (`ResponsibleGamblingFooter`).

## Confidence vs. probability

Confidence must never be computed as a function of probability alone. It
reflects data completeness/sample size/model agreement
(`generatePredictions.ts::confidenceFor`). A 70% probability backed by 3
matches of data is "low confidence," not "high confidence."

## Provider abstraction

Application code (routes, services, the frontend) never imports a vendor
SDK or calls a third-party API directly. All external football/odds/weather
data goes through the interfaces in `backend/src/providers/types.ts`. Adding
a real provider means writing one class and registering it in
`providers/registry.ts` — no other file changes.

## TypeScript

- `strict: true` and `noUncheckedIndexedAccess: true` everywhere. Handle the
  `undefined` case explicitly rather than asserting it away.
- No `any`. Use `unknown` at provider/API boundaries and validate with `zod`
  before trusting shape.
- Prefer `const`; ESLint enforces this.

## Python (ML service)

- The ML service is a pure function of its request payload: no database
  access, no outbound HTTP calls, no hidden state. This keeps it trivially
  unit-testable and horizontally scalable.
- Any model assumption that isn't backed by a fitted parameter (e.g. the
  Dixon-Coles `RHO` constant) must be documented in code as an
  approximation, not presented as calibrated.

## Testing

Every unit of business logic (freshness classification, provider fallback
behavior, the Poisson market math, prediction confidence/risk derivation)
ships with tests that assert the actual invariant (probabilities sum to 1,
a stronger team is favoured, insufficient data is never silently upgraded
to a confident prediction) — not just "it doesn't throw."

## Commits

Small, real, verified changes. Run typecheck + tests + lint for every
service touched before considering a change done — see the CI workflow
(`.github/workflows/ci.yml`) for the exact commands.
