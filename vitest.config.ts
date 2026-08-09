import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // PGlite boots a WASM Postgres per suite; the default 5s is too tight.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
