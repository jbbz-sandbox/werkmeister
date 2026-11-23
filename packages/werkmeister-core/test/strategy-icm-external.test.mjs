// SW-1077 (SW-1071 design): ICM workflows from repo and user folders.
// Every write goes under withSandboxHome; run-tests.sh refuses a HOME holding the real ~/.werkmeister (SW-662).

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { sandboxHome } from "../dist/config.js";
import { WorkspaceError } from "../dist/errors.js";
import { validateFormData } from "../dist/form_schema.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { createWorkspace, getFormSchema } from "../dist/sandbox.js";
import { ICM_TEMPLATES, stageGrants, templateFor } from "../dist/strategies/icm_templates.js";
import { strategyById } from "../dist/strategies/index.js";
import { _WIZARD_PROMPTS } from "../dist/workspace_prompts.js";
import { pinWerkmeisterRoot, useDockerEngine, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();
useDockerEngine();

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
    yml.push(
      `  - name: ${s.name}`,
      `    job: ${s.job}`,
      "    writes: out.md",
      "    check: read it",
    );
    if (s.grants) yml.push(`    grants: [${s.grants.map((g) => JSON.stringify(g)).join(", ")}]`);
    if (s.yaml) yml.push(`    ${s.yaml}`);
  }
  fs.writeFileSync(path.join(dir, "workflow.yaml"), `${yml.join("\n")}\n`);
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(dir, "stages", `${name}.md`), body);
}

const REVIEW = {
  stages: [
    { name: "triage", job: "sort the findings", grants: ["issue view"] },
    { name: "report", job: "write the report" },
  ],
  files: {
    triage: STAGE("EXTERNAL-TRIAGE sort what came in for {{repos}}."),
    report: STAGE(
      "EXTERNAL-REPORT write it up.",
      "- Working (this run): `{{at:triage}}/output/out.md`\n",
    ),
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
      // check() names the workspace by its folder, so init must too.
      workspaceName: path.basename(root),
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

const builtinNames = () =>
  Object.fromEntries(Object.entries(ICM_TEMPLATES).map(([k, v]) => [k, v.map((s) => s.name)]));

test("a repo workflow adds a new work_type; contracts come from it; writes stay in the temp home", async () => {
  const before = builtinNames();
  await withWs(async (root, ctx, home) => {
    writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "review"), REVIEW);
    const log = collectingReporter();
    withReporter(log, () => icm.init(ctx));
    assert.match(
      log.text(),
      /work_type "review": workflow from .*demo-repo\/\.werkmeister\/workflows\/review\./,
    );
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
    assert.match(
      fs.readFileSync(path.join(root, "CONTEXT.md"), "utf8"),
      /`01_triage` \| sort the findings/,
    );
    assert.deepEqual(stageGrants("review", root), ["issue view"]);
    assert.deepEqual(icm.check(root), [], "check re-renders from the same external workflow");

    for (const f of walk(root))
      assert.ok(f.startsWith(home + path.sep), `${f} is under the temp home`);
  }, "review");
  assert.deepEqual(builtinNames(), before, "built-in templates unchanged");
});

test("built-ins render byte-identical when an external workflow of another name exists", async () => {
  for (const wt of Object.keys(ICM_TEMPLATES)) {
    const plain = await withWs((root, ctx) => {
      withReporter(collectingReporter(), () => icm.init(ctx));
      return fs.readFileSync(
        path.join(root, `stages/01_${templateFor(wt)[0].name}/CONTEXT.md`),
        "utf8",
      );
    }, wt);
    const withExt = await withWs((root, ctx) => {
      writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "review"), REVIEW);
      withReporter(collectingReporter(), () => icm.init(ctx));
      return fs.readFileSync(
        path.join(root, `stages/01_${templateFor(wt)[0].name}/CONTEXT.md`),
        "utf8",
      );
    }, wt);
    // Only the temp paths differ between the two runs.
    const norm = (s) => s.replace(/\/[^\s`]*werkmeister-home-[^\s`/]*/g, "<home>");
    assert.equal(norm(withExt), norm(plain), wt);
  }
});

test("override precedence: repo beats user beats built-in, reported at init", async () => {
  await withWs(async (root, ctx, home) => {
    const spike1 = {
      stages: [{ name: "only", job: "user spike" }],
      files: { only: STAGE("USER-SPIKE") },
    };
    writeWorkflow(path.join(home, "workflows", "spike"), spike1);
    assert.deepEqual(
      templateFor("spike", root).map((s) => s.name),
      ["only"],
    );
    const log = collectingReporter();
    withReporter(log, () => icm.init(ctx));
    assert.match(log.text(), /workflow from .*\/workflows\/spike \(replaces the built-in spike\)/);

    const spike2 = {
      stages: [{ name: "repo-one", job: "repo spike" }],
      files: { "repo-one": STAGE("REPO-SPIKE") },
    };
    writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "spike"), spike2);
    assert.deepEqual(
      templateFor("spike", root).map((s) => s.name),
      ["repo-one"],
    );
    // Without a workspace (e.g. the form's choices) repo folders are unseen; the user folder still applies.
    assert.deepEqual(
      templateFor("spike").map((s) => s.name),
      ["only"],
    );
  }, "spike");
});

test("invalid workflows fail init with the path and the reason, never fall back", async () => {
  const cases = [
    [{ ...REVIEW, version: 2 }, /`version: 1` is required/],
    [
      { ...REVIEW, stages: [{ name: "triage", job: "x", grants: ["pr open"] }] },
      /grants pr open not allowed/,
    ],
    [{ stages: [{ name: "triage", job: "x" }], files: {} }, /no stages\/triage\.md/],
    [
      { stages: [{ name: "triage", job: "x" }], files: { triage: STAGE("{{oops}}") } },
      /unknown variable \{\{oops\}\}/,
    ],
    [
      { stages: [{ name: "triage", job: "x" }], files: { triage: STAGE("{{at:nope}}") } },
      /\{\{at:nope\}\} names no stage/,
    ],
    [
      {
        stages: [{ name: "triage", job: "x" }],
        files: { triage: "One job: x\n\n## Inputs\n- a\n" },
      },
      /missing or empty/,
    ],
    [
      {
        stages: [
          { name: "a", job: "x" },
          { name: "a", job: "y" },
        ],
        files: { a: STAGE("a") },
      },
      /duplicate stage name "a"/,
    ],
    [
      { stages: [{ name: "a", job: "x", yaml: "standards: core" }], files: { a: STAGE("a") } },
      /`standards` must be none, all or a list/,
    ],
    [
      { stages: [{ name: "a", job: "x", yaml: "gate: { x: 1 }" }], files: { a: STAGE("a") } },
      /`gate` must be text/,
    ],
    [
      { stages: [{ name: "a", job: "x" }], files: { a: STAGE("{{Repos}}") } },
      /unknown variable \{\{Repos\}\}/,
    ],
  ];
  for (const [wf, re] of cases) {
    await withWs(async (root, ctx) => {
      const dir = path.join(root, "demo-repo", ".werkmeister", "workflows", "review");
      writeWorkflow(dir, wf);
      assert.throws(
        () => withReporter(collectingReporter(), () => icm.init(ctx)),
        (e) => {
          assert.match(e.message, re);
          assert.ok(e.message.includes(dir), "names the workflow folder");
          return true;
        },
      );
      assert.ok(!fs.existsSync(path.join(root, "stages")), "nothing rendered");
    }, "review");
  }
});

test("a `##` line inside a code fence is text, not a section", async () => {
  const fenced = STAGE("FENCED").replace(
    "## Human check\n",
    "## Human check\n```md\n## Not a section\n# nor a title\n```\n",
  );
  await withWs(async (root, ctx) => {
    writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "review"), {
      stages: [{ name: "triage", job: "x" }],
      files: { triage: fenced },
    });
    withReporter(collectingReporter(), () => icm.init(ctx));
    const body = fs.readFileSync(path.join(root, "stages/01_triage/CONTEXT.md"), "utf8");
    assert.match(body, /```md\n## Not a section\n# nor a title\n```/);
  }, "review");
});

test("grants stay inside the allowlist; a workflow broken after init grants nothing", async () => {
  for (const bad of ["pr open", "feature up"]) {
    await withWs(async (root) => {
      writeWorkflow(path.join(root, "demo-repo", ".werkmeister", "workflows", "review"), {
        ...REVIEW,
        stages: [{ name: "triage", job: "x", grants: [bad] }, REVIEW.stages[1]],
      });
      assert.throws(
        () => templateFor("review", root),
        new RegExp(`grants ${bad} not allowed \\(allowed: issue start, issue view, pr push:\\*\\)`),
      );
    }, "review");
  }
  await withWs(async (root) => {
    const dir = path.join(root, "demo-repo", ".werkmeister", "workflows", "review");
    writeWorkflow(dir, {
      ...REVIEW,
      stages: [
        { name: "triage", job: "x", grants: ["issue start", "pr push:*"] },
        REVIEW.stages[1],
      ],
    });
    assert.deepEqual(stageGrants("review", root), ["issue start", "pr push:*"]);
    fs.writeFileSync(path.join(dir, "workflow.yaml"), "version: 2\nstages: []\n");
    const log = collectingReporter();
    assert.deepEqual(
      withReporter(log, () => stageGrants("review", root)),
      [],
    );
    assert.match(log.text(), /\[warn\].*`version: 1` is required; no grants from it/);
  }, "review");
});

test("a second repo defining the type is reported shadowed; a user folder one is named", async () => {
  await withWs(async (root, ctx, home) => {
    fs.mkdirSync(path.join(root, "z-repo", ".git"), { recursive: true });
    const a = path.join(root, "demo-repo", ".werkmeister", "workflows", "review");
    const b = path.join(root, "z-repo", ".werkmeister", "workflows", "review");
    const user = path.join(home, "workflows", "review");
    writeWorkflow(a, REVIEW);
    writeWorkflow(b, { stages: [{ name: "other", job: "b" }], files: { other: STAGE("B") } });
    writeWorkflow(user, { stages: [{ name: "mine", job: "u" }], files: { mine: STAGE("U") } });
    const log = collectingReporter();
    withReporter(log, () => icm.init(ctx));
    assert.ok(
      log.text().includes(`work_type "review": workflow from ${a}; shadows ${user}.`),
      log.text(),
    );
    assert.ok(
      log
        .text()
        .includes(
          `work_type "review": ${b} is shadowed by ${a} (repos are searched in name order).`,
        ),
      log.text(),
    );
    assert.match(log.text(), /\[warn\].*is shadowed by/);
    assert.ok(
      fs.existsSync(path.join(root, "stages/01_triage")),
      "contracts come from the first repo",
    );
  }, "review");
});

// --- Through createWorkspace / initWorkspace / the CLI: a real repo clone, as workspace_init.test.mjs builds one.

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);

/** A temp repos_root whose demo-repo (cloned from a seed) commits *workflows* (type → spec); fn(tmp, home). */
async function withRepos(workflows, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "external-wf-"));
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git("-C", seed, "init", "-q", "-b", "main");
  for (const [type, wf] of Object.entries(workflows))
    writeWorkflow(path.join(seed, ".werkmeister", "workflows", type), wf);
  git("-C", seed, "add", "-A");
  git("-C", seed, "commit", "-q", "--allow-empty", "-m", "init");
  git("clone", "-q", seed, path.join(tmp, "repos", "demo-repo"));
  const prevRoot = process.env.WERKMEISTER_ROOT;
  process.env.WERKMEISTER_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "cli");
  try {
    return await withSandboxHome((home) => fn(tmp, home), {
      config: `paths:\n  repos_root: ${path.join(tmp, "repos")}\n  workspaces_root: ${path.join(tmp, "ws")}\n`,
      services: `services:\n  backend:\n    type: api\n    repo: demo-repo\n    port_offset: 2\nrepos:\n  demo-repo: { services: [backend] }\n`,
    });
  } finally {
    if (prevRoot === undefined) delete process.env.WERKMEISTER_ROOT;
    else process.env.WERKMEISTER_ROOT = prevRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const BROKEN = { stages: [{ name: "triage", job: "x" }], files: { triage: STAGE("{{oops}}") } };
const CREATE = { open: false, distill: false, build: false };

/** The user folder of the sandbox home, asserted to be the temp one, never the real ~/.werkmeister. */
function userWorkflows(home) {
  const dir = path.join(sandboxHome(), "workflows");
  assert.ok(dir.startsWith(home + path.sep), `${dir} is under the temp home`);
  assert.ok(
    !dir.startsWith(path.join(os.userInfo().homedir, ".werkmeister")),
    "not the real ~/.werkmeister",
  );
  return dir;
}

test("an invalid workflow fails init with one [err] line before .env or .werkmeister/bin exist", async () => {
  await withRepos({ review: BROKEN }, async (tmp) => {
    const err = await withReporter(collectingReporter(), () =>
      createWorkspace(
        { feature: "demo", services: "backend", work_type: "review" },
        { ...CREATE, cwd: tmp },
      ).then(
        () => null,
        (e) => e,
      ),
    );
    // createWorkspace runs init as `werkmeister workspace new` and throws its transcript.
    assert.ok(err instanceof WorkspaceError, `got ${err}`);
    const errs = err.message.split("\n").filter((l) => l.includes("[err]"));
    assert.equal(errs.length, 1, err.message);
    assert.match(
      errs[0],
      /\[err\] {2}ICM workflow .*demo-repo\/\.werkmeister\/workflows\/review.*unknown variable \{\{oops\}\}/,
    );
    assert.doesNotMatch(err.message, /Error:/);
    const ws = path.join(tmp, "ws", "demo");
    assert.ok(
      fs.existsSync(path.join(ws, "demo-repo")),
      "the worktree exists: repo workflows live in it",
    );
    assert.ok(!fs.existsSync(path.join(ws, ".env")), "no .env");
    assert.ok(!fs.existsSync(path.join(ws, ".werkmeister", "bin")), "no .werkmeister/bin");
  });
});

test("`werkmeister workspace init` prints the workflow error as [err], not Error:", async () => {
  await withRepos({ review: BROKEN }, async (tmp) => {
    const ws = path.join(tmp, "ws", "demo");
    await withReporter(collectingReporter(), () =>
      createWorkspace(
        { feature: "demo", services: "backend", work_type: "review" },
        { ...CREATE, cwd: tmp },
      ).catch(() => {}),
    );
    const cli = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "apps",
      "cli",
      "dist",
      "main.js",
    );
    const out = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [cli, "workspace", "init", "--no-build"],
        { cwd: ws, env: { ...process.env, NO_COLOR: "1" } },
        (e, stdout, stderr) => resolve({ code: e?.code ?? 0, text: stdout + stderr }),
      ),
    );
    assert.equal(out.code, 1, out.text);
    assert.match(out.text, /\[err\] +ICM workflow .*unknown variable \{\{oops\}\}/);
    assert.doesNotMatch(out.text, /Error:/);
    assert.ok(!fs.existsSync(path.join(ws, ".env")), "still no .env");
  });
});

test("the create form offers user and repo workflow types and creates a workspace with one", async () => {
  await withRepos({ audit: REVIEW }, async (tmp, home) => {
    writeWorkflow(path.join(userWorkflows(home), "review"), REVIEW);
    const bundle = await getFormSchema();
    const offered = bundle.schema.properties.work_type.enum;
    assert.deepEqual(offered.slice(0, 5), ["feature", "bugfix", "incident", "refactor", "spike"]);
    assert.ok(offered.includes("review") && offered.includes("audit"), offered.join(", "));
    const formData = { feature: "demo", services: ["backend"], work_type: "review" };
    assert.equal(validateFormData(bundle, formData).work_type, undefined);
    // The MCP create-workspace tool's own call.
    const { workspacePath, output } = await withReporter(collectingReporter(), () =>
      createWorkspace({ ...formData, services: "backend" }, { ...CREATE, cwd: tmp }),
    );
    assert.deepEqual(fs.readdirSync(path.join(workspacePath, "stages")).sort(), [
      "01_triage",
      "02_report",
    ]);
    assert.match(output, /work_type "review": workflow from .*\/workflows\/review\./);
  });
});

test("the wizard's work_type pattern takes any lowercase-hyphen type", () => {
  const spec = _WIZARD_PROMPTS.find((p) => p.key === "work_type");
  const re = new RegExp(spec.pattern);
  assert.ok(re.test("team-review"));
  assert.ok(!re.test("Team Review"));
});
