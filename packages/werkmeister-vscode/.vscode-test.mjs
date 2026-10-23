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
  // Pinned, not `stable`: `stable` asks update.code.visualstudio.com on every
  // run, and that lookup has failed CI before any test ran (#151). This is the
  // `engines.vscode` floor. Bump it by hand when a newer VS Code matters, and
  // bump the cache key in .github/workflows/ci.yml with it.
  version: "1.93.0",
  // No folder open: the tree's 5s poll only runs while the view is visible, and
  // nothing here opens it, so no `docker ps` sweep fires during the run.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  // Pin what the host inherits, so the config-tier test asserts against a fixed
  // tier 2 instead of the developer's own shell: WERKMEISTER_ROOT is the value a
  // cleared setting must restore, and WERKMEISTER_BIN is the one with nothing to
  // restore — `undefined` unsets it, since spawn drops undefined env values.
  env: {
    WERKMEISTER_ROOT: "/tmp/sandbox-inherited-root",
    WERKMEISTER_BIN: undefined,
  },
  mocha: {
    ui: "tdd",
    // runInTerminal waits up to 3s for shell integration before sending text.
    timeout: 20_000,
  },
});
