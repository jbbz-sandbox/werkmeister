import { quickpickle } from "quickpickle";
import { defineConfig } from "vitest/config";

// SW-64 spike: Gherkin scenarios against the built binary, run by QuickPickle inside Vitest.
// Delete this folder and the `vitest run -c bdd/...` half of the test script to remove it.
// Started by a calling git (rebase --exec, a hook), these point every fixture `git init` at
// the real repo; deleted here, in the main process, so no worker inherits them (SW-520).
for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete process.env[v];

export default defineConfig({
  plugins: [quickpickle()],
  test: {
    root: import.meta.dirname,
    include: ["**/*.feature"],
    setupFiles: ["./steps.ts"],
    testTimeout: 60_000,
  },
});
