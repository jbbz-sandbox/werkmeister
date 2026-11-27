// SW-1231: a claude workspace keeps its context in AGENTS.md, and CLAUDE.md only imports it, so
// Claude Code loads it whatever CLAUDE.md sits in a folder above. Re-running init migrates an old one.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { exportWorkflow } from "../dist/strategies/index.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const STUB = "@AGENTS.md\n";

function workspace(strategy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-"));
  fs.mkdirSync(path.join(root, ".werkmeister"));
  fs.writeFileSync(
    path.join(root, ".werkmeister", "workspace.yml"),
    `task: Agents file\nwork_type: feature\ncontext_strategy: ${strategy}\n`,
  );
  return root;
}
const init = (root) =>
  withSandboxHome(() => withReporter(collectingReporter(), () => initWorkspace({}, root)));
const read = (root, f) => fs.readFileSync(path.join(root, f), "utf8");

for (const strategy of ["jit", "icm"]) {
  test(`${strategy} init on claude: the context in AGENTS.md, CLAUDE.md only imports it`, async () => {
    const root = workspace(strategy);
    try {
      await init(root);
      assert.match(read(root, "AGENTS.md"), /^# /);
      assert.equal(read(root, "CLAUDE.md"), STUB);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("re-running init migrates a pre-SW-1231 CLAUDE.md and keeps its Handoff Notes", async () => {
  const root = workspace("jit");
  try {
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      "# Workspace: old\n\n## Layout\n\nold layout\n\n## Handoff Notes\n\nkeep me\n",
    );
    const reporter = collectingReporter();
    await withSandboxHome(() => withReporter(reporter, () => initWorkspace({}, root)));
    assert.equal(read(root, "CLAUDE.md"), STUB);
    assert.doesNotMatch(read(root, "AGENTS.md"), /old layout/);
    const notes = path.join(root, ".werkmeister", "notes");
    assert.ok(
      fs.readdirSync(notes).some((n) => read(notes, n).includes("keep me")),
      "the old Handoff Notes were not salvaged",
    );
    // The old file still counts as a previous init.
    assert.match(reporter.text(), /CLAUDE\.md already initialised/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow export reads the router of an icm workspace not re-inited yet (CLAUDE.md only)", async () => {
  const root = workspace("icm");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-export-"));
  try {
    await init(root);
    fs.renameSync(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"));
    fs.rmSync(out, { recursive: true });
    const { stages } = withReporter(collectingReporter(), () => exportWorkflow(root, out));
    assert.ok(stages.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
