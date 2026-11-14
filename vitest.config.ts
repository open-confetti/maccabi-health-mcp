import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Integration files each start processes of their own; running them side by side makes timing flaky.
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: "integration", include: ["test/integration/**/*.test.ts"] } },
      { extends: true, test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
    ],
  },
});
