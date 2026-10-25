// composeLogsStream against a real daemon: what a unit test with a fake one
// can't show is that the Engine's real stream comes out prefixed and coloured,
// and that stop() really closes it. A tail that outlives its caller is the
// orphan the VS Code pane exists to avoid.
import assert from "node:assert/strict";

import { composeLogsStream } from "./dist/compose.js";
import { projectContainers } from "./dist/docker.js";

// Running only: a created-but-never-started stack has no logs to tail.
const all = await projectContainers(undefined, undefined, { all: false });
if (all === null) {
  console.log("compose-logs.smoke SKIPPED (no reachable daemon)");
  process.exit(0);
}

// Inside a workspace container, use its own feature: the daemon is the host's,
// so the list holds other workspaces too (#148).
const feature =
  process.env.SANDBOX_FEATURE ||
  all
    .map((c) => c.labels["com.docker.compose.project"] ?? "")
    // `sandbox-` until a workspace's first `up` after SW-93; SW-11 drops it.
    .map((n) => /^(?:werkmeister|sandbox)-(.+)$/.exec(n)?.[1])
    .filter((f) => f && f !== "infra")[0];

if (
  !feature ||
  !all.some((c) =>
    [`werkmeister-${feature}`, `sandbox-${feature}`].includes(
      c.labels["com.docker.compose.project"],
    ),
  )
) {
  console.log("compose-logs.smoke SKIPPED (no feature stack running)");
  process.exit(0);
}

let output = "";
const tail = composeLogsStream(feature, null, (chunk) => (output += chunk));

// Long enough for the backlog; --tail is bounded, so this is not a race
// against an unbounded stream.
await new Promise((resolve) => setTimeout(resolve, 4_000));

assert.ok(output.length > 0, "expected log output");
assert.match(
  output,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts the raw ANSI colour code
  /\u001b\[3[0-9]m\S+ +\| \u001b\[0m/,
  "expected a coloured `name | ` prefix",
);

tail.stop();
// Settles only once every container stream has closed.
await tail.done;

let missing = "";
await composeLogsStream(feature, "no-such-service-hopefully", (c) => (missing += c)).done;
assert.equal(missing, "no such service: no-such-service-hopefully\n");

console.log(
  `compose-logs.smoke: PASS (feature '${feature}', ${output.length} bytes, ANSI present)`,
);
