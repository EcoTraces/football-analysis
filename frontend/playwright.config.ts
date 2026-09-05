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
    // --host 127.0.0.1 is load-bearing, not cosmetic: without an explicit
    // host, vite binds whatever "localhost" resolves to via Node's DNS
    // order, which on some CI runners is ::1 (IPv6-only) — leaving nothing
    // listening on the literal 127.0.0.1 this config's url polls. That
    // produced a silent "Timed out waiting Nms from config.webServer" with
    // no crash and no useful log (the actual CI failure this replaced),
    // since the request just never connects rather than erroring loudly.
    command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
