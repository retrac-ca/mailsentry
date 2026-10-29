import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/diagnostics/**", "src/providers/**", "src/security/**"],
      reporter: ["text", "lcov"],
    },
  },
});
