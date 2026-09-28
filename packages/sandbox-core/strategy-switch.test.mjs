// Switching context_strategy leaves the old layer in place with a warning;
// --prune-context deletes only what git can restore, and never a path the new
// strategy also owns. Controller ruling P3: there is no `previous` local —
// initWorkspace checks every OTHER registered strategy's owned paths after
// strategy.init runs, since the value read at init start is already the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { leftoverPaths, reportLeftovers, strategyById } from "./dist/strategies/index.js";
import { initWorkspace } from "./dist/workspace_init.js";

const jit = strategyById("jit");
const icm = strategyById("icm");

function write(root, rel, body = "x\n") {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function jitWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-"));
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write(root, "CLAUDE.md");
  write(root, ".claude/skills/sb-research/SKILL.md");
  write(root, ".claude/skills/mine/SKILL.md");
  write(root, ".claude/agents/sb-researcher.md");
  write(root, ".claude/settings.json", "{}\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  write(root, ".claude/agents/sb-researcher.md", "edited\n"); // dirty
  write(root, ".sandbox/notes/001-handoff-x.md"); // untracked
  return root;
}

test("leftovers are the old layer's existing paths minus the new layer's", () => {
  const root = jitWorkspace();
  try {
    assert.deepEqual(leftoverPaths(root, jit, icm), [
      ".claude/settings.json",
      ".claude/skills/sb-research",
      ".claude/agents/sb-researcher.md",
      ".sandbox/notes",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without prune: one warning, nothing deleted", async () => {
  const root = jitWorkspace();
  try {
    const c = collectingReporter();
    await withReporter(c, async () => reportLeftovers(root, jit, icm, false));
    assert.match(c.text(), /jit layer still present: .*\.claude\/skills\/sb-research.*--prune-context/);
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "sb-research")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prune deletes tracked clean paths only", async () => {
  const root = jitWorkspace();
  try {
    const c = collectingReporter();
    await withReporter(c, async () => reportLeftovers(root, jit, icm, true));
    assert.ok(!fs.existsSync(path.join(root, ".claude", "skills", "sb-research")));
    assert.ok(!fs.existsSync(path.join(root, ".claude", "settings.json")));
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "mine", "SKILL.md")), "not jit's");
    assert.equal(fs.readFileSync(path.join(root, ".claude", "agents", "sb-researcher.md"), "utf8"), "edited\n");
    assert.ok(fs.existsSync(path.join(root, ".sandbox", "notes", "001-handoff-x.md")), "untracked kept");
    assert.ok(fs.existsSync(path.join(root, "CLAUDE.md")), "icm owns it too");
    assert.match(c.text(), /Kept \.claude\/agents\/sb-researcher\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("not a git repo: prune keeps everything", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-nogit-"));
  try {
    write(root, ".claude/skills/sb-research/SKILL.md");
    await withReporter(collectingReporter(), async () => reportLeftovers(root, jit, icm, true));
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills", "sb-research", "SKILL.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A fresh init of either strategy must not warn about the other: nothing it
// writes today happens to match the other's ownedPaths globs.
test("fresh icm workspace has no jit leftovers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-fresh-icm-"));
  try {
    write(root, "CLAUDE.md");
    write(root, "CONTEXT.md");
    write(root, "BRIEF.md");
    write(root, "_shared/standards.md");
    write(root, "stages/research/output/.gitkeep");
    assert.deepEqual(leftoverPaths(root, jit, icm), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh jit workspace has no icm leftovers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-fresh-jit-"));
  try {
    write(root, "CLAUDE.md");
    write(root, ".claude/settings.json", "{}\n");
    write(root, ".claude/skills/sb-research/SKILL.md");
    write(root, ".claude/agents/sb-researcher.md");
    write(root, ".sandbox/notes/001-handoff-x.md");
    write(root, ".sandbox/standards.json", "{}\n");
    write(root, ".sandbox/.gate/manifest.json");
    assert.deepEqual(leftoverPaths(root, icm, jit), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Init-level: jit -> icm via workspace.yml edit + rerun. Controller ruling P3's
// scenario — the field read at the start of the second run is already "icm",
// so the leftover check has to walk every OTHER registered strategy rather
// than compare against a `previous` local.
async function jitThenSwitchToIcm(root, std) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");

  fs.mkdirSync(path.join(root, ".sandbox"));
  fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), "task: Switch test\nwork_type: feature\n");

  await withSandboxHome(async () => withReporter(collectingReporter(), () => initWorkspace({}, root)), {
    config: `overrides:\n  standards_dir: ${std}\n`,
  });

  git("add", "-A");
  git("commit", "-qm", "jit init");

  const yml = fs.readFileSync(path.join(root, ".sandbox", "workspace.yml"), "utf8");
  fs.writeFileSync(
    path.join(root, ".sandbox", "workspace.yml"),
    yml.replace(/context_strategy:.*\n/, "") + "context_strategy: icm\n",
  );
}

test("initWorkspace warns about jit leftovers after a workspace.yml switch to icm", async () => {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "switch-init-std-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-init-ws-"));
  try {
    await jitThenSwitchToIcm(root, std);

    const c = collectingReporter();
    await withSandboxHome(
      async () => withReporter(c, () => initWorkspace({}, root)),
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
    assert.match(c.text(), /jit layer still present: .*\.claude\/skills\/sb-.*--prune-context/);
    assert.ok(fs.existsSync(path.join(root, ".claude", "skills")), "not pruned without the flag");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});

test("initWorkspace --prune-context removes tracked jit leftovers after a switch to icm", async () => {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "switch-init-std2-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switch-init-ws2-"));
  try {
    await jitThenSwitchToIcm(root, std);

    const c = collectingReporter();
    await withSandboxHome(
      async () => withReporter(c, () => initWorkspace({ prune_context: true }, root)),
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
    assert.ok(
      !fs.existsSync(path.join(root, ".claude", "skills", "sb-research")),
      "jit-tracked skills pruned",
    );
    assert.ok(!fs.existsSync(path.join(root, ".claude", "settings.json")), "jit-tracked settings pruned");
    assert.ok(
      !fs.existsSync(path.join(root, ".claude", "agents", "sb-researcher.md")),
      "jit-tracked agent pruned",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});
