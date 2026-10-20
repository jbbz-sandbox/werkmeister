// composeLogsStream is the one compose wrapper that streams, so the things that
// can break in it are invisible to a unit test: whether `--ansi always` really
// survives a non-TTY pipe (compose prints no colour onto one by default, which
// would silently flatten the VS Code tail it exists to feed), and whether the
// returned child can actually be killed — a tail that outlives its caller is
// the orphan the extension switched to this function to avoid.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { composeLogsStream } from "./dist/compose.js";

let projects = [];
try {
  projects = JSON.parse(
    execFileSync("docker", ["compose", "ls", "--format", "json"], {
      encoding: "utf8",
      timeout: 15_000,
    }),
  );
} catch {
  console.log("compose-logs.smoke SKIPPED (no reachable daemon)");
  process.exit(0);
}

// composeLogsStream resolves the compose file from a feature name, which is the
// compose project minus the prefix init-workspace always writes. Inside a
// workspace container, use its own feature: the daemon is the host's, so the
// list holds other workspaces whose compose files this container can't see (#148).
const feature =
  process.env.SANDBOX_FEATURE ||
  projects
    .map((p) => p.Name ?? "")
    .filter((n) => n.startsWith("sandbox-") && n !== "sandbox-infra")
    .map((n) => n.slice("sandbox-".length))[0];

if (!feature) {
  console.log("compose-logs.smoke SKIPPED (no feature stack running)");
  process.exit(0);
}

let output = "";
const child = composeLogsStream(feature, null, (chunk) => (output += chunk));
if (!child) {
  console.log(`compose-logs.smoke SKIPPED (compose file for '${feature}' not reachable here)`);
  process.exit(0);
}

// Long enough for compose to emit its backlog; --tail is bounded so this is not
// a race against an unbounded stream.
await new Promise((resolve) => setTimeout(resolve, 4_000));

assert.ok(output.length > 0, "expected log output");
assert.match(
  output,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts the raw ANSI colour code
  /\u001b\[3[0-9]m/,
  "expected ANSI from `--ansi always` — without it the per-service prefix colour is dropped",
);

// `close` fires once: if the tail already exited on its own, waiting for it would
// never settle and Node exits 13 on the unsettled await (SW-37).
const hasExited = () => child.exitCode !== null || child.signalCode !== null;
child.kill();
if (!hasExited()) {
  await new Promise((resolve) => child.once("close", resolve));
}
// Not `child.killed`: that stays false when the child had already exited.
assert.ok(hasExited(), "expected the tail to die with its caller");

assert.equal(
  composeLogsStream("no-such-feature-hopefully", null, () => {}),
  null,
  "expected null rather than a doomed child when the feature has no compose file",
);

console.log(
  `compose-logs.smoke: PASS (feature '${feature}', ${output.length} bytes, ANSI present)`,
);
