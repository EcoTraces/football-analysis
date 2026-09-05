import { test, expect, type Page } from "@playwright/test";

// No VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY are set for this test run
// (no .env file is present, and none is created here) — exercising the
// "not configured" fallback every real deployment shows until those are
// set, per frontend/.env.example. This is deliberate, not an oversight:
// see e2e/README.md for why a real sign-in flow needs a live Supabase
// project this suite doesn't have.

// "Failed to load resource" is the browser's own diagnostic for a failed
// network request (here: the Google Fonts <link> in index.html, which a
// sandboxed/offline CI runner may not have egress for) — a real signal
// worth knowing about, but not an app bug, and not this test's concern.
// pageerror (an uncaught JS exception) and any other console.error the
// app's own code actually made are what this guards against.
const EXPECTED_NOISE = /Failed to load resource/;

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !EXPECTED_NOISE.test(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("sign-in shows the unconfigured-auth fallback, not a blank page, with no console errors", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/sign-in");

  await expect(page.getByRole("link", { name: "Football Analysis" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Authentication is not configured on this deployment");
  // The unconfigured SignIn page returns its alert instead of the real
  // form — confirms this isn't a blank/broken page rendering nothing.
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("sign-up shows the same unconfigured-auth fallback", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/sign-up");

  await expect(page.getByRole("alert")).toContainText("Authentication is not configured on this deployment");
  expect(errors).toEqual([]);
});

test("toggles dark mode and persists the choice across a reload", async ({ page }) => {
  await page.goto("/sign-in");

  const toggle = page.getByRole("button", { name: "Switch to dark mode" });
  await expect(toggle).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await toggle.click();

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();

  await page.reload();

  // localStorage persists across reload (same origin) — the choice should
  // survive it, not silently revert to the OS/browser preference.
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("has no horizontal overflow on a narrow mobile viewport (390px)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in");

  await expect(page.getByRole("alert")).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test("has no horizontal overflow on a wide desktop viewport (1280px)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/sign-in");

  await expect(page.getByRole("alert")).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test("direct navigation to a client-routed path doesn't 404 (SPA routing works)", async ({ page }) => {
  const response = await page.goto("/sign-in");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("alert")).toBeVisible();
});
