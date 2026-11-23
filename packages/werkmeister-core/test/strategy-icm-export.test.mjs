// SW-1079: `werkmeister workflow export` writes a workspace's stages as a workflow folder that loads back.
// Every write goes under withSandboxHome; run-tests.sh refuses a HOME holding the real ~/.werkmeister (SW-662).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { sandboxHome } from "../dist/config.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import {
  ALLOWED_GRANTS,
  grantsFor,
  loadWorkflow,
  USER_GRANTS,
  WorkflowError,
} from "../dist/strategies/icm_external.js";
import { ICM_TEMPLATES } from "../dist/strategies/icm_templates.js";
import { exportWorkflow, strategyById } from "../dist/strategies/index.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const icm = strategyById("icm");

/** Init an icm workspace of *workType* under *home*, with one repo `demo-repo`; returns its root. */
function initWs(home, workType, autonomous) {
  const root = fs.mkdtempSync(path.join(home, "ws-"));
  fs.mkdirSync(path.join(root, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".werkmeister", "workspace.yml"),
    `context_strategy: icm\nwork_type: ${workType}\nfeature: demo\nservices: api\nautonomous: "${autonomous}"\nstarting_prompt: p\nissue_id: SW-1\n`,
  );
  withReporter(collectingReporter(), () =>
    icm.init({
      workspaceRoot: root,
      workspaceName: path.basename(root),
      repos: [["demo-repo", "me/demo"]],
      task: "t",
      meta: { FEATURE: "demo", SERVICES: "api", ISSUE_ID: "SW-1" },
      inputs: { work_type: workType, starting_prompt: "p", autonomous: String(autonomous) },
      hasServiceMap: false,
      configOverride: null,
    }),
  );
  return root;
}

/** Every contract file init renders, the workspace's own name blanked so two workspaces compare. */
function rendered(root) {
  const stages = fs.readdirSync(path.join(root, "stages")).sort();
  const files = ["CONTEXT.md", "CLAUDE.md", ...stages.map((d) => `stages/${d}/CONTEXT.md`)];
  return Object.fromEntries(
    files.map((f) => [
      f,
      fs.readFileSync(path.join(root, f), "utf8").replaceAll(path.basename(root), "<ws>"),
    ]),
  );
}

for (const workType of Object.keys(ICM_TEMPLATES))
  for (const autonomous of [false, true])
    test(`${workType} (autonomous ${autonomous}) exports and loads back byte-identical`, async () => {
      await withSandboxHome(async (home) => {
        assert.equal(sandboxHome(), home);
        const a = initWs(home, workType, autonomous);
        // The person's own folder, where every built-in grant loads (USER_GRANTS).
        const out = path.join(sandboxHome(), "workflows", workType);
        const { stages, warnings } = exportWorkflow(a, out);
        assert.deepEqual(
          stages,
          ICM_TEMPLATES[workType].map((s) => s.name),
        );
        assert.equal(
          warnings.some((w) => w.startsWith("autonomous workspace")),
          autonomous,
        );
        const b = initWs(home, workType, autonomous);
        assert.ok(
          fs.existsSync(path.join(b, ".werkmeister", "workflow.lock")),
          "B rendered from the export",
        );
        assert.deepEqual(rendered(b), rendered(a));
      });
    });

test("the export strips what werkmeister adds and restores the variables", async () => {
  await withSandboxHome(async (home) => {
    const out = path.join(home, "export");
    exportWorkflow(initWs(home, "feature", false), out);
    const research = fs.readFileSync(path.join(out, "stages", "research.md"), "utf8");
    const spec = fs.readFileSync(path.join(out, "stages", "spec.md"), "utf8");
    assert.doesNotMatch(
      research,
      /## Pre-approved|^0\. |Ask this check|Reference \(every run\): `\.\.\/\.\.\/_shared\/standards/m,
    );
    assert.match(spec, /\{\{at:research\}\}\/output\/decisions\.md/);
    assert.doesNotMatch(spec, /\.\.\/01_research/);
    const yml = fs.readFileSync(path.join(out, "workflow.yaml"), "utf8");
    assert.match(yml, /^version: 1$/m);
    assert.match(yml, /grants:\n\s+- issue start\n\s+- issue view/);
    assert.match(yml, /gate: spec\.md/);
    // The worktree paths and reload line are this workspace's; the template carries the variables.
    for (const f of fs.readdirSync(path.join(out, "stages")))
      assert.doesNotMatch(
        fs.readFileSync(path.join(out, "stages", f), "utf8"),
        /demo-repo|docker restart demo-api/,
      );
  });
});

test("a jit workspace or a non-empty --to is refused and nothing is written", async () => {
  await withSandboxHome(async (home) => {
    const a = initWs(home, "feature", false);
    const full = path.join(home, "full");
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, "keep.md"), "mine");
    assert.throws(() => exportWorkflow(a, full), WorkflowError);
    assert.deepEqual(fs.readdirSync(full), ["keep.md"]);

    const jit = fs.mkdtempSync(path.join(home, "jit-"));
    fs.mkdirSync(path.join(jit, ".werkmeister"));
    fs.writeFileSync(path.join(jit, ".werkmeister", "workspace.yml"), "context_strategy: jit\n");
    assert.throws(() => exportWorkflow(jit, path.join(home, "out")), /not an icm workspace/);
    assert.equal(fs.existsSync(path.join(home, "out")), false);
  });
});

test("a hand-edited contract the loader rejects fails the export and leaves no folder content", async () => {
  await withSandboxHome(async (home) => {
    const a = initWs(home, "feature", false);
    const ctx = path.join(a, "stages", "01_research", "CONTEXT.md");
    fs.appendFileSync(ctx, "\nSee {{nope}}.\n");
    const out = path.join(home, "export");
    assert.throws(() => exportWorkflow(a, out), /unknown variable \{\{nope\}\}/);
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
  });
});

test("every built-in grant loads from the user folder, so a built-in exports and loads", () => {
  for (const [type, stages] of Object.entries(ICM_TEMPLATES))
    for (const s of stages)
      for (const g of s.grants ?? []) assert.ok(USER_GRANTS.includes(g), `${type}/${s.name}: ${g}`);
});

test("a repo workflow still may not grant workspace serve or pr autosquash; the export warns", async () => {
  await withSandboxHome(async (home) => {
    const a = initWs(home, "feature", false);
    const repoDir = path.join(a, "demo-repo", ".werkmeister", "workflows", "feature");
    const { warnings } = exportWorkflow(a, repoDir);
    assert.ok(warnings.some((w) => /workspace serve:\*.*~\/\.werkmeister\/workflows/.test(w)));
    assert.ok(!ALLOWED_GRANTS.includes("workspace serve:*"));
    assert.throws(() => loadWorkflow(repoDir), /grants workspace serve:\* not allowed/);
  });
});

test("a grant edited into a contract is dropped with a warning, not exported", async () => {
  await withSandboxHome(async (home) => {
    const a = initWs(home, "feature", false);
    const ctx = path.join(a, "stages", "01_research", "CONTEXT.md");
    const text = fs.readFileSync(ctx, "utf8");
    fs.writeFileSync(
      ctx,
      text.replace("## Pre-approved\n", "## Pre-approved\n- `werkmeister workspace serve …`\n"),
    );
    const out = path.join(sandboxHome(), "workflows", "feature");
    const { warnings } = exportWorkflow(a, out);
    assert.ok(warnings.some((w) => /dropped grants workspace serve:\*/.test(w)));
    // research keeps only its template's grants; implement's own workspace serve is untouched.
    const yml = fs.readFileSync(path.join(out, "workflow.yaml"), "utf8");
    const research = yml.slice(yml.indexOf("- name: research"), yml.indexOf("- name: spec"));
    assert.doesNotMatch(research, /workspace serve/);
    assert.match(yml, /- name: implement[\s\S]*workspace serve:\*/);
  });
});

test("grantsFor gives the user grants only inside ~/.werkmeister/workflows/<type>", async () => {
  await withSandboxHome(async () => {
    const root = path.join(sandboxHome(), "workflows");
    assert.equal(grantsFor(path.join(root, "feature")), USER_GRANTS);
    for (const dir of [
      root,
      `${root}-x/feature`,
      path.join(root, "..", "x"),
      "/tmp/workflows/feature",
    ])
      assert.equal(grantsFor(dir), ALLOWED_GRANTS, dir);
  });
});
