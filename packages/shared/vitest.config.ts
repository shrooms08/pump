import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Relative to this package, so `pnpm --filter @pump/shared test` finds the suite.
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
