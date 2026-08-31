import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The landing site is a separate package with its own dependencies and
    // its own vitest run (see landing/vitest.config.ts and the
    // test-landing job in CI). Without this exclusion the root run
    // discovers landing/api/*.test.ts and fails in CI, where landing's
    // node_modules are deliberately not installed -- it only passed
    // locally because both packages happened to be installed.
    exclude: ["**/node_modules/**", "**/dist/**", "landing/**", "corpus/**"],
  },
});
