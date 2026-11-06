import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "ember-evaluator": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["tests/fixtures/test-home.ts"],
    watch: false,
    // Several files spawn Node/npm processes; keep filesystem/process pressure
    // bounded instead of scaling their startup cost with every host CPU.
    maxWorkers: 4,
    include: [
      "tests/unit/**/*.test.{ts,mjs}",
      "tests/integration/**/*.test.ts",
    ],
    passWithNoTests: false,
  },
});
