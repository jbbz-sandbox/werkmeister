// Smoke test for tallyComposeContainers: groups containers by Compose project,
// tallies running/total, retains per-container name+state, and excludes one-shot
// setup services that have finished (they're expected to exit).
//   npm run build && node lib/sandbox.smoke.mjs
import assert from "node:assert";

const { tallyComposeContainers } = await import("sandbox-core");

// Rows as the Engine API reports them: `state` is `State` ("running"/"exited"),
// `status` is `Status` ("Up 16 hours (healthy)") and carries both the health
// verdict and the clean-exit check. Infra containers carry no slot label, and the
// `-setup` rows deliberately carry no role label — that is what a container
// created before the label was added looks like.
const row = (project, service, state, status, slot = "", role = "") => ({
  project,
  service,
  state,
  status,
  slot,
  role,
});

const containers = [
  row("sandbox-infra", "redis", "running", "Up 16 hours (healthy)"),
  row("sandbox-infra", "caddy", "running", "Up 16 hours"), // no healthcheck declared
  row("sandbox-infra", "k8s-forwards", "exited", "Exited (0) 2 minutes ago"),
  row("sandbox-my-feature", "frontend", "running", "Up 3 minutes (health: starting)", "2"),
  row("sandbox-my-feature", "backend", "exited", "Exited (1) 1 minute ago", "2"),
  row("sandbox-my-feature", "econ-setup", "exited", "Exited (0) 5 minutes ago", "2"),
];

const result = tallyComposeContainers(containers);

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
  result.get("sandbox-my-feature").services.find((s) => s.name === "frontend").health,
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

// The bug this label fixes: a setup container whose name does not end in
// `-setup` (the scaffold ships `demo-install`) was counted as a failed service,
// turning a fully healthy workspace yellow. The role label identifies it.
const labelled = tallyComposeContainers([
  row("sandbox-foo-bar", "frontend", "running", "Up 2 hours (healthy)", "1", "app"),
  row("sandbox-foo-bar", "backend", "running", "Up 2 hours (healthy)", "1", "app"),
  row("sandbox-foo-bar", "demo-install", "exited", "Exited (0) 2 hours ago", "1", "setup"),
]).get("sandbox-foo-bar");
assert.equal(labelled.total, 2, "completed role=setup container excluded from the tally");
assert.equal(labelled.running, 2, "workspace reads fully up, not 2/3");

// A setup container that failed is a real failure — it stays in the tally so the
// workspace reads degraded and its row (and logs) stay visible.
const failed = tallyComposeContainers([
  row("sandbox-foo-bar", "frontend", "running", "Up 2 hours (healthy)", "1", "app"),
  row("sandbox-foo-bar", "demo-install", "exited", "Exited (1) 2 hours ago", "1", "setup"),
]).get("sandbox-foo-bar");
assert.equal(failed.total, 2, "failed setup container stays in the tally");
assert.equal(failed.running, 1, "...and drags the workspace to partial");

// Containers with no compose-project label (anything not started by compose) are
// ignored, not counted. The shelled `docker ps` produced these as blank columns;
// the Engine API produces them as a missing label, mapped to "".
const withNoise = tallyComposeContainers([row("", "", "running", "Up 1 hour"), ...containers]);
assert.equal(withNoise.get("sandbox-infra").total, 3, "unlabelled containers don't affect real tallies");

console.log(
  "✓ tallyComposeContainers: grouping, running/total tally, per-container detail, setup exclusion (role label + -setup fallback), failed-setup retention, unlabelled containers",
);
process.exit(0);
