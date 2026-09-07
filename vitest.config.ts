import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/seam/**/*.test.ts"],
    setupFiles: ["tests/support/cleanup.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
