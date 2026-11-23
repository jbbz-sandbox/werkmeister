// SW-1071 spike PoC: an ICM workflow from outside the werkmeister source.
if (process.env.WERKMEISTER_TEMP_HOME !== process.env.HOME)
  throw new Error("run me through with-temp-home");

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { sandboxHome } from "../dist/config.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { ICM_TEMPLATES, stageGrants, templateFor } from "../dist/strategies/icm_templates.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const icm = strategyById("icm");

const STAGE = (job, extra = "") => `# ignored title

One job: ${job}

## Inputs
- Working (this run): \`../../BRIEF.md\`
${extra}
## Do NOT load
source trees.

## Process
1. Read the brief.
2. Write the output.

## Outputs
- \`output/out.md\`

## Human check
Flip \`status: proposed\` to \`status: decided\`.
`;

function writeWorkflow(dir, { stages, files, version = 1 }) {
  fs.mkdirSync(path.join(dir, "stages"), { recursive: true });
  const yml = [`version: ${version}`, "stages:"];
  for (const s of stages) {
    yml.push(`  - name: ${s.name}`, `    job: ${s.job}`, "    writes: out.md", "    check: read it");
    if (s.grants) yml.push(`    grants: [${s.grants.map((g) => JSON.stringify(g)).join(", ")}]`);
  }
  fs.writeFileSync(path.join(dir, "workflow.yaml"), `${yml.join("\n")}\n`);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, "stages", `${name}.md`), body);
}

const REVIEW = {
  stages: [
    { name: "triage", job: "sort the findings", grants: ["issue view"] },
    { name: "report", job: "write the report" },
  ],
  files: {
    triage: STAGE("EXTERNAL-TRIAGE sort what came in for {{repos}}."),
    report: STAGE("EXTERNAL-REPORT write it up.", "- Working (this run): `{{at:triage}}/output/out.md`\n"),
  },
};

/** A workspace with one repo under the sandbox home; fn(root, ctx, home). Every path is under *home*. */
function withWs(fn, workType) {
  return withSandboxHome(async (home) => {
    assert.equal(sandboxHome(), home, "~/.werkmeister resolves into the temp home");
    const root = fs.mkdtempSync(path.join(home, "ws-"));
    fs.mkdirSync(path.join(root, "demo-repo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(
      path.join(root, ".werkmeister", "workspace.yml"),
      `context_strategy: icm\nwork_type: ${workType}\nfeature: demo\nservices: api\nautonomous: "false"\nstarting_prompt: p\n`,
    );
    const ctx = {
      workspaceRoot: root,
      workspaceName: "demo",
      repos: [["demo-repo", "me/demo"]],
      task: "t",
      meta: { FEATURE: "demo", SERVICES: "api" },
      inputs: { work_type: workType, starting_prompt: "p", autonomous: "false" },
      hasServiceMap: false,
      configOverride: null,
    };
    return fn(root, ctx, home);
  });
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [p];
  });
}

const builtinNames = () => Object.fromEntries(Object.entries(ICM_TEMPLATES).map(([k, v]) => [k, v.map((s) => s.name)]));

test("a repo workflow adds a new work_type; contracts come from it; writes stay in the temp home", async () => {
  const before = builtinNames();
  await withWs(async (root, ctx, home) => {
    writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "review"), REVIEW);
    const log = collectingReporter();
    withReporter(log, () => icm.init(ctx));
    assert.match(log.text(), /work_type "review": workflow from .*demo-repo\/\.werkmeister\/workflows\/review\./);
    assert.doesNotMatch(log.text(), /is not a template/);

    const triage = fs.readFileSync(path.join(root, "stages/01_triage/CONTEXT.md"), "utf8");
    const report = fs.readFileSync(path.join(root, "stages/02_report/CONTEXT.md"), "utf8");
    assert.match(triage, /^# 01_triage — sort the findings$/m);
    assert.match(triage, /EXTERNAL-TRIAGE sort what came in for `\.\.\/\.\.\/demo-repo\/`\./);
    assert.match(triage, /- `werkmeister issue view`/);
    assert.match(triage, /## Human check\nFlip/);
    assert.match(report, /EXTERNAL-REPORT/);
    assert.match(report, /- Working \(this run\): `\.\.\/01_triage\/output\/out\.md`/);
    assert.doesNotMatch(report, /\{\{|undefined/);
    assert.match(fs.readFileSync(path.join(root, "CONTEXT.md"), "utf8"), /`01_triage` \| sort the findings/);
    assert.deepEqual(stageGrants("review", root), ["issue view"]);
    assert.deepEqual(icm.check(root), [], "check re-renders from the same external workflow");

    for (const f of walk(root)) assert.ok(f.startsWith(home + path.sep), `${f} is under the temp home`);
  }, "review");
  assert.deepEqual(builtinNames(), before, "built-in templates unchanged");
});

test("built-ins render byte-identical when an external workflow of another name exists", async () => {
  for (const wt of Object.keys(ICM_TEMPLATES)) {
    const plain = await withWs((root, ctx) => {
      withReporter(collectingReporter(), () => icm.init(ctx));
      return fs.readFileSync(path.join(root, `stages/01_${templateFor(wt)[0].name}/CONTEXT.md`), "utf8");
    }, wt);
    const withExt = await withWs((root, ctx) => {
      writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "review"), REVIEW);
      withReporter(collectingReporter(), () => icm.init(ctx));
      return fs.readFileSync(path.join(root, `stages/01_${templateFor(wt)[0].name}/CONTEXT.md`), "utf8");
    }, wt);
    // Only the temp paths differ between the two runs.
    const norm = (s) => s.replace(/\/[^\s`]*werkmeister-home-[^\s`/]*/g, "<home>");
    assert.equal(norm(withExt), norm(plain), wt);
  }
});

test("override precedence: repo beats user beats built-in, reported at init", async () => {
  await withWs(async (root, ctx, home) => {
    const spike1 = { stages: [{ name: "only", job: "user spike" }], files: { only: STAGE("USER-SPIKE") } };
    writeWorkflow(path.join(home, "workflows", "spike"), spike1);
    assert.deepEqual(templateFor("spike", root).map((s) => s.name), ["only"]);
    const log = collectingReporter();
    withReporter(log, () => icm.init(ctx));
    assert.match(log.text(), /workflow from .*\/workflows\/spike \(replaces the built-in spike\)/);

    const spike2 = { stages: [{ name: "repo-one", job: "repo spike" }], files: { "repo-one": STAGE("REPO-SPIKE") } };
    writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "spike"), spike2);
    assert.deepEqual(templateFor("spike", root).map((s) => s.name), ["repo-one"]);
    // Without a workspace (e.g. the form's choices) only the built-in is seen.
    assert.deepEqual(templateFor("spike").map((s) => s.name), ["questions", "findings"]);
  }, "spike");
});

test("invalid workflows fail init with the path and the reason, never fall back", async () => {
  const cases = [
    [{ ...REVIEW, version: 2 }, /`version: 1` is required/],
    [{ ...REVIEW, stages: [{ name: "triage", job: "x", grants: ["pr open"] }] }, /grants pr open not allowed/],
    [{ stages: [{ name: "triage", job: "x" }], files: {} }, /no stages\/triage\.md/],
    [{ stages: [{ name: "triage", job: "x" }], files: { triage: STAGE("{{oops}}") } }, /unknown variable \{\{oops\}\}/],
    [{ stages: [{ name: "triage", job: "x" }], files: { triage: STAGE("{{at:nope}}") } }, /\{\{at:nope\}\} names no stage/],
    [{ stages: [{ name: "triage", job: "x" }], files: { triage: "One job: x\n\n## Inputs\n- a\n" } }, /missing or empty/],
    [{ stages: [{ name: "a", job: "x" }, { name: "a", job: "y" }], files: { a: STAGE("a") } }, /duplicate stage name "a"/],
  ];
  for (const [wf, re] of cases) {
    await withWs(async (root, ctx) => {
      const dir = path.join(root, "demo-repo", ".werkmeister", "workflows", "review");
      writeWorkflow(dir, wf);
      assert.throws(() => withReporter(collectingReporter(), () => icm.init(ctx)), (e) => {
        assert.match(e.message, re);
        assert.ok(e.message.includes(dir), "names the workflow folder");
        return true;
      });
      assert.ok(!fs.existsSync(path.join(root, "stages")), "nothing rendered");
    }, "review");
  }
});
