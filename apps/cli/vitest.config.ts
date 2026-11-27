import fs from "node:fs";
import { defineConfig } from "vitest/config";

// SW-1242: resolve werkmeister-core to its source, so a test never passes against a stale dist.
// Built from core's exports map ("./x": "./dist/<p>.js" is src/<p>.ts) so it tracks new entry points.
const coreDir = new URL("../../packages/werkmeister-core/", import.meta.url);
const coreExports: Record<string, string> = JSON.parse(
  fs.readFileSync(new URL("package.json", coreDir), "utf8"),
).exports;
const coreAliases = Object.entries(coreExports).map(([sub, target]) => ({
  find: new RegExp(`^werkmeister-core${sub === "." ? "" : sub.slice(1)}$`),
  replacement: new URL(target.replace(/^\.\/dist\/(.*)\.js$/, "src/$1.ts"), coreDir).pathname,
}));

// Cases spawn processes and do heavy fs work, and their wall time scales with host load: next to other
// workspaces' suites a 1 s case takes 10-50 s, so vitest's 5 s/10 s defaults fail whichever case starves (#178, #206).
// A case that is one or more starts of the bundled CLI (bins, spellings) took 90-97 s against 60 s (SW-567).
// No daemon at DOCKER_HOST, so a Docker call a test forgot to mock fails in ms instead of waiting on the
// host's loaded daemon: a sync `docker ps` blocking a fork past vitest's fixed 60 s worker RPC timeout
// fails a green run, and an unbounded dockerode `df` hangs a case to testTimeout (SW-158).
// Started by a calling git (rebase --exec, a hook), these point every fixture `git init` at
// the real repo; deleted here, in the main process, so no worker inherits them (SW-520).
for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete process.env[v];

export default defineConfig({
  resolve: { alias: coreAliases },
  test: {
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Likewise no werkmeister daemon: the scheduler falls back in-process rather than reach the host's (SW-185).
    env: {
      DOCKER_HOST: "unix:///nonexistent/werkmeister-tests.sock",
      // Refused like a stopped daemon; fetch rejects :9 as a "bad port" before connecting (SW-743).
      // shortcut: a port-0 listener can be handed 65535 on macOS; bind-and-close one (SW-708) if that flakes.
      WERKMEISTER_HOST: "http://127.0.0.1:65535",
      WERKMEISTER_DAEMON_RETRY_MS: "500",
    },
    // Read only with `--coverage` (`test:coverage`, SW-405); plain `vitest run` measures nothing.
    coverage: {
      provider: "v8",
      reporter: ["json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      // Files a test loads only, as c8 reports the other packages; vitest 3 otherwise adds every file at 0 %.
      all: false,
      // A red run still reports, as c8 does, so the gate logs its row.
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
