/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    css: true,
    setupFiles: ["./src/setupTests.ts"],
    // e2e/ holds Playwright specs (run via `npm run test:e2e`, not
    // vitest) — vitest's default include glob would otherwise pick them
    // up and fail trying to run Playwright's test() through vitest's own
    // runner. Extends, not replaces, vitest's own exclude defaults.
    exclude: [...configDefaults.exclude, "e2e/**"]
  }
});
