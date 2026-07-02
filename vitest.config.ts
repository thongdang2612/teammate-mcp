import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      // src/index.ts is HTTP/stdio process wiring (argv, express app, listen()) —
      // integration-tested manually per task 14, not worth mocking express/net for.
      exclude: ["src/index.ts"],
    },
  },
});
