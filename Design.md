# Design

This documents the frontend's actual design system and the redesign work
done against it — not a spec for a bigger product than exists. See
`README.md` for what's actually implemented; this file covers *how it
looks*, not what it does.

## Scope discipline

This redesign covers the **6 routes that actually exist**: `/` (today's
fixtures), `/matches/:id`, `/sign-in`, `/sign-up`, `/admin`,
`/admin/users`. Team pages, league pages, an accumulator, search, filters,
charts, and a public landing page were explicitly **not** built — none of
them have backend support (no `/teams/:id` or `/leagues/:id` routes, no
accumulator concept anywhere in the schema, no search endpoint), and
building UI for them would mean either inventing data or silently adding
new backend surface neither of which this task asked for. Building a
convincing-looking shell around data that doesn't exist would violate this
project's own first principle (`Coding_Rules.md` → "No Fake Data Rule").
If any of those become real backend features later, they get their own
design pass against real endpoints, not before.

## Color

Built on the existing `pitch` green (already established, already
football-appropriate) rather than replacing it. Extended with `400`/`700`/
`800` shades for hover/active/pressed states that didn't exist before:

```
pitch-50   #f1f8f4
pitch-100  #dcefe2
pitch-400  #2e9463   (new — hover/active accents)
pitch-500  #1f7a4d
pitch-600  #186339   (primary buttons/links)
pitch-700  #124c2c   (new — hover state)
pitch-800  #0f3f25   (new — pressed state)
pitch-900  #0d3320
```

Semantic status/freshness colors (green=success, blue=info, amber=warning,
red=danger, slate=neutral) were already in use but defined **twice** —
once in `FreshnessBadge`, once in `AdminDashboard`'s `StatusBadge` — with
the same five color pairs copy-pasted. Consolidated into one shared
`components/Badge.tsx` with a `BadgeVariant` type
(`success | info | warning | danger | neutral`); both call sites now map
their own domain-specific labels onto that one variant set instead of
each owning a parallel copy of the same Tailwind classes.

Backgrounds/borders/muted text still use Tailwind's default `slate` scale
(`bg-white`/`dark:bg-slate-950`, `border-slate-200`/`dark:border-slate-800`,
`text-slate-500`/`dark:text-slate-400`) — already-verified AA contrast
pairs, deliberately not replaced with a bespoke neutral scale.

## Typography

- **Inter** for all UI text and headings (loaded via Google Fonts `<link>`
  in `index.html`, applied as `font-sans` in `tailwind.config.ts`) —
  neutral, highly legible, reads as a serious analytics product rather
  than a decorative one. No display/serif font — there's no landing page
  or hero section for one to serve.
- **JetBrains Mono** for prediction percentages and other tabular figures
  (`font-mono`, already applied to probability spans in `PredictionCard`)
  — fixed-width digits keep a column of numbers from shifting as values
  change, and `tabular-nums` is applied alongside it on every probability
  value.

## Components

New shared primitives (`frontend/src/components/`):

- **`Badge.tsx`** — the semantic-variant badge described above.
- **`Skeleton.tsx`** — a pulsing placeholder shaped like the content it's
  standing in for (not a generic spinner), with `motion-reduce:animate-none`
  so `prefers-reduced-motion` is respected.
- **`EmptyState.tsx`** — title + optional description, used wherever a
  successful load returns zero rows (never a bare blank list).
- **`ErrorState.tsx`** — `role="alert"`, plain-language message, optional
  `onRetry` button. Never exposes a raw error object, stack trace, or key.

`FreshnessBadge` now delegates its rendering to `Badge` (same visual
output, same `role="status"`, same labels — internals only).

## Information hierarchy: `PredictionCard`'s `variant` prop

`MatchDetail` used to render all ~20 prediction markets in one
undifferentiated grid — a genuine usability problem flagged in this
redesign's own audit, since the primary 1x2 market (who wins) had no more
visual weight than `odd_even_goals`. Fixed with a `variant?: "primary" |
"secondary"` prop on the existing `PredictionCard` (one reusable
component, not a near-duplicate):

- **`variant="primary"`** (used once, for the `1x2` market): larger
  padding, a tinted `pitch`-colored panel, the leading selection shown at
  `text-3xl` next to its label, confidence/data-quality below it, and the
  market's other selections (e.g. draw/away) listed compactly underneath.
- **`variant="secondary"`** (the default, used for every other market):
  the original compact card, unchanged in appearance.

`MatchDetail` now renders the primary card up front, then every other
market inside a native `<details>`/`<summary>` "More markets & analysis"
disclosure — zero-dependency, keyboard-operable, and accessible by
default, rather than hand-rolling tab or accordion state.

## Fixed: raw team UUIDs instead of names

The single most "unfinished" thing this redesign's own audit found:
`FixturesToday` and `MatchDetail` rendered `fixture.homeTeamId` /
`match.home_team_id` directly — literal UUIDs where a team name belongs.
This was a backend gap, not a CSS one: `fixturesService.ts` and the
`/matches/:id` route never joined `teams`.

Fixed with a new `backend/src/services/teamsService.ts`
(`getTeamNamesById`) — batched via `.in("id", teamIds)` rather than one
request per team, consistent with the "fetch raw rows, aggregate in JS"
pattern already used elsewhere in this backend (`FakeSupabase` has no
join support, so every existing service that needs cross-table data
already does the join in application code, not Postgres). Both
`FixtureSummary` and the `/matches/:id` response gained
`homeTeamName`/`awayTeamName: string | null` — `null`, never a fabricated
name, when a team's own row has no name yet; the UI falls back to the raw
id in that case rather than showing nothing.

## Fixed: header nav overflow risk

`Layout.tsx`'s `AuthNav` rendered "Admin" + the signed-in user's full
email + "Sign out" + the theme toggle in one non-wrapping flex row. A
realistic email alongside those other three elements had nowhere to
shrink to on a narrow phone. Fixed with `flex-wrap` on the nav row,
`min-w-0`/`truncate`/a responsive `max-w-*` on the email span (full
address still available via its `title` attribute), and `shrink-0` on the
elements that shouldn't compress.

## Brand mark

A small inline SVG (`BrandMark` in `Layout.tsx`) — a green rounded square
with pitch-line-style strokes — sized to sit inline with the "Football
Analysis" wordmark in the header, not layered on top of it as a separate
sticker. No icon library dependency added for one mark.

## States

Every one of the 6 real pages now has an explicit loading (skeleton),
empty, and error (with retry) state — `FixturesToday` and `MatchDetail`
previously used plain, accessible-but-unstyled text for these; they now
use the shared `Skeleton`/`EmptyState`/`ErrorState` components.

## Verified

Visual QA was done with a live Playwright render of `/sign-in` (the one
route reachable without a real Supabase project) at 390px (mobile) and
1280px (desktop) in both light and dark mode, confirming: fonts load
correctly, the header wraps rather than overflowing on mobile, and dark
mode contrast holds. `/`, `/matches/:id`, and `/admin` were verified
through their respective test suites (loading/team-name/empty/error state
assertions) rather than a live render, since they require a real signed-in
session this environment doesn't have credentials for.

Full three-service verification: backend 220/220 tests (6 new, covering
team-name enrichment and its null-fallback), frontend 55/55 tests (10
new, covering the two previously-untested pages' loading/empty/error/
team-name states), ml-service 68/68 (untouched, confirms no cross-service
breakage). `tsc`/`eslint`/`npm run build` clean across all three.
