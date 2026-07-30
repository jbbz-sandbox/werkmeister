// Smoke test for parseComposeStatus: groups docker-ps lines by Compose project,
// tallies running/total, retains per-container name+state, and excludes one-shot
// `-setup` services from the tally (they're expected to exit).
//   npm run build && node lib/sandbox.smoke.mjs
import assert from "node:assert";

const { parseComposeStatus } = await import("sandbox-driver");

// Mixed running/exited containers across two projects, plus a one-shot setup
// container that should be excluded entirely. Column 4 is `{{.Status}}` (health
// verdict) and column 5 is the `com.sandbox.local.slot` label — both fields
// the Health tab needs. Infra containers carry no slot label.
const psOutput = [
  "sandbox-infra\tredis\trunning\tUp 16 hours (healthy)\t",
  "sandbox-infra\tcaddy\trunning\tUp 16 hours\t", // no healthcheck declared
  "sandbox-infra\tk8s-forwards\texited\tExited (0) 2 minutes ago\t",
  "sandbox-my-feature\tnext-hello\trunning\tUp 3 minutes (health: starting)\t2",
  "sandbox-my-feature\trest-hello\texited\tExited (1) 1 minute ago\t2",
  "sandbox-my-feature\tecon-setup\texited\tExited (0) 5 minutes ago\t2",
].join("\n");

const result = parseComposeStatus(psOutput);

const infra = result.get("sandbox-infra");
assert.equal(infra.running, 2, "2 of 3 sandbox-infra containers running");
assert.equal(infra.total, 3, "3 sandbox-infra containers total");
assert.equal(infra.slot, null, "infra has no slot label");
assert.deepEqual(
  infra.services,
  [
    { name: "redis", state: "running", health: "healthy" },
    { name: "caddy", state: "running", health: "" },
    { name: "k8s-forwards", state: "exited", health: "" },
  ],
  "per-container name+state+health retained in project order",
);
assert.equal(
  result.get("sandbox-my-feature").services.find((s) => s.name === "next-hello").health,
  "starting",
  "'(health: starting)' parsed to 'starting'",
);
assert.equal(result.get("sandbox-my-feature").slot, 2, "feature slot parsed from label");

const feature = result.get("sandbox-my-feature");
assert.equal(feature.running, 1, "1 of 2 non-setup sandbox-my-feature containers running");
assert.equal(feature.total, 2, "econ-setup excluded from the tally");
assert.equal(
  feature.services.find((s) => s.name === "econ-setup"),
  undefined,
  "one-shot -setup service excluded from services list too",
);

// Blank lines and rows with no compose-project label are ignored, not counted.
const withNoise = parseComposeStatus("\n\t\tno-project-label\n" + psOutput);
assert.equal(withNoise.get("sandbox-infra").total, 3, "noise lines don't affect real tallies");

console.log("✓ parseComposeStatus: grouping, running/total tally, per-container detail, -setup exclusion, noise lines");
process.exit(0);
