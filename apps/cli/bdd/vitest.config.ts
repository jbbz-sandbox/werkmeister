import { quickpickle } from "quickpickle";
import { defineConfig } from "vitest/config";

// SW-64 spike: Gherkin scenarios against the built binary, run by QuickPickle inside Vitest.
// Delete this folder and the `vitest run -c bdd/...` half of the test script to remove it.
export default defineConfig({
  plugins: [quickpickle()],
  test: {
    root: import.meta.dirname,
    include: ["**/*.feature"],
    setupFiles: ["./steps.ts"],
    testTimeout: 60_000,
  },
});
