// SW-971: the Health tab lists a workspace with no containers when it waits on the person, as the pane does.
//   npm run build && node test/health-rows.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { healthRows } = await import(path.join(pkgRoot, "dist/lib/health-rows.js"));

const gate = {
  id: "gate:stages/01_reproduce/output/repro.md",
  kind: "gate",
  what: "Approve stages/01_reproduce/output/repro.md",
  since: null,
  action: "Read it",
  source: "gate",
};
const status = (name, total, needs = [], slot = null) => ({
  name,
  slot,
  state: total ? "up" : "down",
  running: total,
  total,
  services: [],
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
  workspaceState: {
    phase: { id: "building", label: "", stage: null },
    activity: { id: "idle", label: "Idle", since: null, session: null },
    needs,
    agent: { id: needs.length ? "needs-you" : "idle", since: null },
  },
});

const rows = healthRows(
  [status("quiet", 0), status("gated", 0, [gate], 2), status("up", 2, [], 1)],
  {},
);
assert.deepEqual(
  rows.map((r) => r.f.name),
  ["up", "gated"],
  "a gate with nothing up shows, by slot; a quiet workspace with nothing up doesn't",
);
assert.deepEqual(
  rows[1].d.needsList.map((n) => n.what),
  ["Approve stages/01_reproduce/output/repro.md"],
);

// A PR poll's need alone is enough too.
const pr = {
  prNeeds: [{ ...gate, id: "ci-failed:r", kind: "ci-failed", what: "CI failed", source: "pr" }],
};
assert.deepEqual(
  healthRows([status("ci", 0)], { ci: pr }).map((r) => r.f.name),
  ["ci"],
);
assert.deepEqual(healthRows([status("quiet", 0)], {}), [], "nothing to show: the empty message");
console.log("health-rows smoke: ok");
