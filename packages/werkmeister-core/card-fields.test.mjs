// SW-47: the workspace-card fields core returns — ICM stage, JIT phase,
// autonomous / autoStop / model, last activity, and CI per PR.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "card-fields-home-"));
const root = path.join(home, "features");
process.env.HOME = home;
process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";
process.env.SANDBOX_WORKSPACES_ROOT = root;

const { ciOf, getWorkspaceStatuses, icmStage } = await import("./dist/sandbox.js");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function stages(dir, outputs) {
  for (const [name, files] of Object.entries(outputs)) {
    fs.mkdirSync(path.join(dir, "stages", name, "output"), { recursive: true });
    for (const f of files) write(path.join(dir, "stages", name, "output", f), "x\n");
  }
}

test("ciOf: no checks, pass, running, fail", () => {
  assert.deepEqual(ciOf(undefined), { ci: null, failingChecks: 0 });
  assert.deepEqual(ciOf([]), { ci: null, failingChecks: 0 });
  const done = (conclusion) => ({ __typename: "CheckRun", status: "COMPLETED", conclusion });
  assert.deepEqual(ciOf([done("SUCCESS"), done("NEUTRAL"), done("SKIPPED")]), {
    ci: "pass",
    failingChecks: 0,
  });
  assert.deepEqual(ciOf([{ __typename: "StatusContext", state: "SUCCESS" }]), {
    ci: "pass",
    failingChecks: 0,
  });
  assert.deepEqual(ciOf([done("SUCCESS"), { status: "IN_PROGRESS", conclusion: "" }]), {
    ci: "running",
    failingChecks: 0,
  });
  assert.deepEqual(ciOf([{ __typename: "StatusContext", state: "PENDING" }]), {
    ci: "running",
    failingChecks: 0,
  });
  assert.deepEqual(ciOf([done("FAILURE"), { status: "QUEUED", conclusion: "" }]), {
    ci: "fail",
    failingChecks: 1,
  });
  assert.deepEqual(ciOf([{ __typename: "StatusContext", state: "ERROR" }]), {
    ci: "fail",
    failingChecks: 1,
  });
});

test("icmStage: first stage with an empty output/, dotfiles don't count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-stage-"));
  assert.equal(await icmStage(dir), null);
  stages(dir, { "01_research": ["inventory.md"], "02_spec": [".gitkeep"], "03_implement": [] });
  fs.mkdirSync(path.join(dir, "stages", "notes"));
  assert.deepEqual(await icmStage(dir), { index: 2, total: 3, name: "spec" });
  stages(dir, { "02_spec": ["spec.md"], "03_implement": ["exercise.md"] });
  assert.equal(await icmStage(dir), null);
});

test("getWorkspaceStatuses: card fields for an ICM and a JIT workspace", async () => {
  const icm = path.join(root, "a-icm");
  write(path.join(icm, ".sandbox", "workspace.yml"), "autonomous: true\nmodel: sonnet\n");
  stages(icm, { "01_research": [], "02_spec": [] });
  const project = path.join(home, ".claude", "projects", icm.replace(/[^a-zA-Z0-9]/g, "-"));
  write(
    path.join(project, "s1.jsonl"),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`,
  );
  const when = new Date("2026-10-01T12:00:00Z");
  fs.utimesSync(path.join(project, "s1.jsonl"), when, when);

  const jit = path.join(root, "b-jit");
  write(path.join(jit, ".sandbox", "workspace.yml"), "autonomous: true\nauto_stop: false\n");
  const note = (file, fm) =>
    write(path.join(jit, ".sandbox", "notes", file), `---\n${fm}\n---\nbody\n`);
  note("001-handoff-start.md", "type: handoff\nphase: research");
  note("002-decision-plan.md", "type: decision\nphase: implement\nstatus: decided");
  note("003-finding-old.md", "type: finding\nphase: test\nstatus: superseded");
  note("004-attempt-nophase.md", "type: attempt");

  const { statuses } = await getWorkspaceStatuses();
  const [a, b] = statuses;
  assert.equal(a.name, "a-icm");
  assert.deepEqual(a.stage, { index: 1, total: 2, name: "research" });
  assert.equal(a.phase, null);
  assert.equal(a.autonomous, true);
  assert.equal(a.autoStop, true, "unset auto_stop follows autonomous");
  assert.equal(a.model, "sonnet");
  assert.equal(a.lastActivity, when.toISOString());
  assert.ok(Array.isArray(a.services));

  assert.equal(b.name, "b-jit");
  assert.equal(b.stage, null);
  assert.equal(b.phase, "implement");
  assert.equal(b.autonomous, true);
  assert.equal(b.autoStop, false);
  assert.equal(b.model, null);
  assert.equal(b.lastActivity, null);
});
