// The icm strategy's init: the files icm-ws2 ran with, generated from
// InitContext alone, and the write-once rules that protect a run in progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withSandboxHome } from "./fixtures.mjs";
import { discoverRepos } from "./dist/workspace_init.js";
import { buildPrGuardEntry } from "./dist/hooks_gen.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { strategyById } from "./dist/strategies/index.js";
import { templateFor } from "./dist/strategies/icm_templates.js";

const PROMPT = "## Goal\n\nDocument the backend API.\n\n## Open questions\n\n1. UI or raw spec?";

function walk(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out.sort();
}

/** A workspace with one repo and a two-module standards tree; returns [root, ctx]. */
async function withIcmWorkspace(fn, { inputs = {}, meta = { FEATURE: "demo", SERVICES: "backend" } } = {}) {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "icm-std-"));
  fs.mkdirSync(path.join(std, "comments"));
  fs.writeFileSync(
    path.join(std, "comments", "STANDARD.md"),
    "---\ndomain: comments\nuniversal: 1\napplies_to:\n  - \"**/*\"\nsummary: why not what\n---\n\n# Comments\n",
  );
  fs.mkdirSync(path.join(std, "ui"));
  fs.writeFileSync(
    path.join(std, "ui", "STANDARD.md"),
    "---\ndomain: ui\napplies_to:\n  - \"**/*.tsx\"\nsummary: ui\n---\n\n# UI\n",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-ws-"));
  fs.mkdirSync(path.join(root, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".sandbox"));
  const allInputs = { context_strategy: "icm", work_type: "feature", starting_prompt: PROMPT, feature: meta.FEATURE, services: meta.SERVICES, ...inputs };
  fs.writeFileSync(
    path.join(root, ".sandbox", "workspace.yml"),
    Object.entries(allInputs).filter(([, v]) => v).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n",
  );
  const ctx = {
    workspaceRoot: root,
    workspaceName: path.basename(root),
    repos: [["demo-repo", "me/demo"]],
    task: "OpenAPI docs",
    meta,
    inputs: allInputs,
    hasServiceMap: false,
    configOverride: null,
  };
  try {
    return await withSandboxHome(
      () => withReporter(collectingReporter(), async () => fn(root, ctx)),
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
}

const icm = strategyById("icm");

test("init writes the icm layer and nothing of jit's", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx);
    const files = walk(root).filter((f) => !f.startsWith("demo-repo") && !f.startsWith(".sandbox"));
    assert.deepEqual(files, [
      ".claude/settings.json",
      "BRIEF.md",
      "CLAUDE.md",
      "CONTEXT.md",
      "_shared/issues-report.md",
      "_shared/pr-rules.md",
      "_shared/standards.md",
      "stages/01_research/CONTEXT.md",
      "stages/01_research/output/.gitkeep",
      "stages/02_spec/CONTEXT.md",
      "stages/02_spec/output/.gitkeep",
      "stages/03_implement/CONTEXT.md",
      "stages/03_implement/output/.gitkeep",
      "stages/04_propose/CONTEXT.md",
      "stages/04_propose/output/.gitkeep",
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")), {
      hooks: { PreToolUse: [buildPrGuardEntry()] },
    });
    assert.ok(!fs.existsSync(path.join(root, ".sandbox", "notes")));
    assert.ok(!fs.existsSync(path.join(root, ".sandbox", "standards.json")));

    assert.ok(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8").endsWith(`\n${PROMPT}\n`));

    const standards = fs.readFileSync(path.join(root, "_shared", "standards.md"), "utf8");
    assert.match(standards, /^\| comments \| `.*comments\/STANDARD\.md` \| any code edit \|$/m);
    assert.match(standards, /^\| ponytail \| already loaded/m);
    assert.match(standards, /do not load\): ui\./);

    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    assert.ok(claude.split("\n").length <= 60, `CLAUDE.md is ${claude.split("\n").length} lines`);
    assert.match(claude, /`docker restart demo-backend`/);
    assert.match(claude, /`stages\/02_spec\/CONTEXT\.md`/);
    assert.match(claude, /you hit a bug or need to log a feature\/task .*`_shared\/issues-report\.md`/);
    assert.match(claude, /^\| this folder's git branch \| the run's record .*never open a PR from it or merge it \|$/m);
    assert.match(claude, /^\| asked to open or create a PR — including `\/create-pr` .*`_shared\/pr-rules\.md`, then `sandbox pr open` \|/m);
    assert.match(fs.readFileSync(path.join(root, "_shared", "pr-rules.md"), "utf8"), /`stages\/04_propose\/output\/pr-<repo>\.md`/);
    assert.ok(!fs.existsSync(path.join(root, "_shared", "bug-report.md")));
    const guide = fs.readFileSync(path.join(root, "_shared", "issues-report.md"), "utf8");
    assert.match(guide, /^# Filing an issue$/m);
    assert.match(guide, /gh issue create -R jbbz-sandbox\/sandbox --label <label>/);

    const implement = fs.readFileSync(path.join(root, "stages", "03_implement", "CONTEXT.md"), "utf8");
    assert.match(implement, /rows `comments`, `ponytail`/);
    assert.doesNotMatch(implement, /`ui`/);
    assert.match(implement, /never run `sandbox up`/i);
    for (const f of walk(root)) {
      if (f.endsWith(".md")) assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /undefined/, f);
    }
  });
});

test("rerunning init keeps an edited brief and a stage's output", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx);
    fs.writeFileSync(path.join(root, "BRIEF.md"), "edited by a person\n");
    fs.writeFileSync(path.join(root, "stages", "01_research", "output", "x.md"), "artifact\n");
    fs.rmSync(path.join(root, "stages", "01_research", "output", ".gitkeep"));
    icm.init(ctx);
    assert.equal(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), "edited by a person\n");
    assert.equal(fs.readFileSync(path.join(root, "stages", "01_research", "output", "x.md"), "utf8"), "artifact\n");
    assert.ok(!fs.existsSync(path.join(root, "stages", "01_research", "output", ".gitkeep")));
  });
});

test("check is empty right after init, and sync repairs an edited contract", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    icm.init(ctx);
    assert.deepEqual(icm.check(root), []);
    fs.writeFileSync(path.join(root, "stages", "02_spec", "CONTEXT.md"), "hand edit\n");
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "hand edit\n");
    assert.deepEqual(icm.check(root), ["stages/02_spec/CONTEXT.md"]);
    assert.deepEqual(icm.sync(root), { wrote: ["stages/02_spec/CONTEXT.md"] });
    assert.deepEqual(icm.check(root), []);
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "hand edit\n");
  });
});

test("an empty starting prompt still gives the brief a body", async () => {
  await withIcmWorkspace(
    async (root, ctx) => {
      icm.init(ctx);
      assert.match(fs.readFileSync(path.join(root, "BRIEF.md"), "utf8"), /No starting prompt was given/);
    },
    { inputs: { starting_prompt: "" } },
  );
});

test("discoverRepos ignores ICM directories when the workspace root itself is a git repo", async () => {
  await withIcmWorkspace(async (root, ctx) => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    icm.init(ctx);

    const repos = discoverRepos(root);
    assert.deepEqual(repos.map(([name]) => name), ["demo-repo"]);
    // A rerun with the rediscovered repos must agree with contextFromDisk, or `check` reports drift.
    icm.init({ ...ctx, repos });
    assert.deepEqual(icm.check(root), []);
  });
});

test("no feature or services: the restart sentence points at sandbox-context.md", async () => {
  await withIcmWorkspace(
    async (root, ctx) => {
      icm.init(ctx);
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      assert.doesNotMatch(claude, /docker restart/);
      assert.match(claude, /as `\.sandbox\/sandbox-context\.md` describes/);
    },
    { meta: { FEATURE: "", SERVICES: "" } },
  );
});

test("no feature (but services present): the restart sentence still points at sandbox-context.md", async () => {
  await withIcmWorkspace(
    async (root, ctx) => {
      icm.init(ctx);
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      assert.doesNotMatch(claude, /docker restart/);
      assert.match(claude, /as `\.sandbox\/sandbox-context\.md` describes/);
    },
    { meta: { FEATURE: "", SERVICES: "backend" } },
  );
});

test("feature and services both present: the restart sentence uses docker restart", async () => {
  await withIcmWorkspace(
    async (root, ctx) => {
      icm.init(ctx);
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      assert.match(claude, /`docker restart demo-backend`/);
    },
    { meta: { FEATURE: "demo", SERVICES: "backend" } },
  );
});

test("templateFor falls back to feature for free text, and normalises case", () => {
  const feature = templateFor("feature").map((s) => s.name);
  assert.deepEqual(feature, ["research", "spec", "implement", "propose"]);
  assert.deepEqual(templateFor("constructor").map((s) => s.name), feature);
  assert.deepEqual(templateFor(" Feature ").map((s) => s.name), feature);
  assert.deepEqual(templateFor("").map((s) => s.name), feature);
});

test("sessionContext is null and gate is a no-op", () => {
  assert.equal(icm.sessionContext("/nonexistent", {}), null);
  assert.equal(icm.gate(), undefined);
});
