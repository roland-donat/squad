import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server API is the seam, and `tests/seam` is where squad is piloted
    // through it. `tests/ui` holds one exception, argued in its own file: the
    // Markdown renderer carries a declared contract and a safety boundary, and
    // neither is reachable from the API.
    include: ["tests/seam/**/*.test.ts", "tests/ui/**/*.test.tsx"],
    setupFiles: ["tests/support/cleanup.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
