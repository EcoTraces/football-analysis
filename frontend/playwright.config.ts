import { defineConfig, devices } from "@playwright/test";

// E2E smoke tests (Road_map.md Phase 17's "no frontend E2E" gap) —
// deliberately scoped to what's testable with no live Supabase project or
// backend: the unconfigured-auth fallback UI every real deployment shows
// until VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY are set (frontend/
// .env.example), dark/light mode, and responsive layout. This is the same
// class of check a real Supabase project would be needed to go further
// than (a real sign-in, the authenticated app) — see e2e/README.md.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    // 30s was enough locally (warm vite cache) but timed out in CI's first
    // real run: a fresh checkout means vite's dependency pre-bundling has
    // no cache to reuse, and a shared CI runner is slower than a dev
    // machine. 60s covers a cold start with margin.
    timeout: 60_000
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
