# End-to-end tests (Playwright)

Real browser tests against a running dev server (`vite dev`, started
automatically by `playwright.config.ts`'s `webServer`) — closes Road_map.md
Phase 17's "no frontend E2E" gap, honestly scoped to what's actually
testable here.

## What this does and doesn't cover

No `.env` file is present for these tests, so `VITE_SUPABASE_URL`/
`VITE_SUPABASE_ANON_KEY` are unset — the app renders its documented
"not configured" fallback (`frontend/.env.example`) instead of a real
sign-in form. That's deliberate, not a workaround: this repo has no live
Supabase project reachable from CI or this dev environment (the same
caveat as everywhere else in this codebase — see `Data_Sources.md`), so a
real sign-in-and-see-your-fixtures flow isn't something this suite can
exercise without fabricating credentials against a project that doesn't
exist. What it does verify, for real, in a real browser:

- The unconfigured-auth fallback actually renders (not a blank page, not a
  crash) on both `/sign-in` and `/sign-up`.
- Dark/light mode toggles the `dark` class on `<html>` and persists across
  a reload via `localStorage`.
- No horizontal overflow at a narrow mobile width (390px) or a wide
  desktop width (1280px) — the same two breakpoints `Changelog.md`'s one
  prior manual Playwright check used, now automated instead of a one-time
  verification.
- Zero browser console errors during page load.
- Client-side routing doesn't 404 on a direct navigation.

Once a real (or realistically-seeded) Supabase project is reachable from
CI, the next real step here is a genuine sign-in flow and an authenticated
smoke test (fixtures list, a match detail page) — not attempted now
because faking that would mean either a real project this environment
doesn't have, or mocking Supabase's own client deeply enough that the test
stops being an honest end-to-end check of anything.

## Running locally

```bash
npm run test:e2e
```

The first run needs Chromium installed once: `npx playwright install --with-deps chromium`.
