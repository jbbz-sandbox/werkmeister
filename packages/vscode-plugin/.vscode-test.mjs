import { defineConfig } from "@vscode/test-cli";

/**
 * The checks that need a real extension host: command registration and what a
 * command does to the workbench. Everything decidable from the manifest or from
 * pure data is a `node --test` file instead (`npm test`) — those run in ~100ms
 * and don't download a VS Code build.
 *
 * Tests are CommonJS on purpose: `vscode` is injected into the CJS module
 * registry by the host, so an ESM `import "vscode"` cannot resolve it, even
 * though this package is `"type": "module"`.
 */
export default defineConfig({
  files: "src/test/*.test.cjs",
  // No folder open: the tree's 5s poll only runs while the view is visible, and
  // nothing here opens it, so no `docker ps` sweep fires during the run.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  mocha: {
    ui: "tdd",
    // runInTerminal waits up to 3s for shell integration before sending text.
    timeout: 20_000,
  },
});
