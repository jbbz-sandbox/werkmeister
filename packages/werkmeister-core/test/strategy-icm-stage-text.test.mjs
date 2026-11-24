// SW-190: a service's (or its archetype's) `stages:` text in the matching ICM stage contracts.
// Every write goes under withSandboxHome; run-tests.sh refuses a HOME holding the real ~/.werkmeister (SW-662).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { stageTextBlocks } from "../dist/archetypes.js";
import { sandboxHome } from "../dist/config.js";
import { SandboxError } from "../dist/errors.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { WorkflowError } from "../dist/strategies/icm_external.js";
import { exportWorkflow, strategyById } from "../dist/strategies/index.js";
import { initWorkspace, WorkspaceInitError } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, useDockerEngine, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();
useDockerEngine();

const icm = strategyById("icm");

const REGISTRY = `archetypes:
  subgraph:
    stages:
      research: ARCH-RESEARCH list the entities.
      implement: ARCH-IMPLEMENT compose the supergraph.
services:
  products:
    repo: demo-repo
    archetype: subgraph
    stages:
      spec: OWN-SPEC state the schema diff.
      implement: OWN-IMPLEMENT products composes alone.
      exercise: OWN-EXERCISE query through the router.
  orders:
    repo: demo-repo
    archetype: subgraph
  users:
    repo: demo-repo
    archetype: subgraph
  other:
    repo: other-repo
    stages:
      research: OTHER-RESEARCH never shown.
repos:
  demo-repo:
    services: [products, orders, users]
  other-repo:
    services: [other]
`;

/** Init an icm workspace of *workType* with repo `demo-repo` under *home*; returns its root. */
function initWs(home, workType, services = "products,orders,users") {
  const root = fs.mkdtempSync(path.join(home, "ws-"));
  fs.mkdirSync(path.join(root, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".werkmeister", "workspace.yml"),
    `context_strategy: icm\nwork_type: ${workType}\nfeature: demo\nservices: ${services}\nautonomous: "false"\nstarting_prompt: p\n`,
  );
  withReporter(collectingReporter(), () =>
    icm.init({
      workspaceRoot: root,
      workspaceName: path.basename(root),
      repos: [["demo-repo", "me/demo"]],
      task: "t",
      meta: { FEATURE: "demo", SERVICES: services },
      inputs: { work_type: workType, starting_prompt: "p", autonomous: "false" },
      hasServiceMap: false,
      configOverride: null,
    }),
  );
  return root;
}

const contract = (root, dir) =>
  fs.readFileSync(path.join(root, "stages", dir, "CONTEXT.md"), "utf8");
const allContracts = (root) =>
  fs
    .readdirSync(path.join(root, "stages"))
    .map((d) => contract(root, d))
    .join("\n");
const section = (c) => /## For this workspace's services\n\n([\s\S]*?)\n\n## Outputs/.exec(c)?.[1];

test("feature: each role lands in its stage, own text beats the archetype's, shared text is grouped", async () => {
  await withSandboxHome(
    async (home) => {
      assert.equal(sandboxHome(), home);
      const root = initWs(home, "feature");
      assert.equal(
        section(contract(root, "01_research")),
        "### `orders`, `products`, `users` (archetype `subgraph`)\nARCH-RESEARCH list the entities.",
      );
      assert.equal(
        section(contract(root, "02_spec")),
        "### `products`\nOWN-SPEC state the schema diff.",
      );
      // Feature has no exercise stage: implement takes implement text, then exercise text.
      assert.equal(
        section(contract(root, "03_implement")),
        [
          "### `orders`, `users` (archetype `subgraph`)\nARCH-IMPLEMENT compose the supergraph.",
          "### `products`\nOWN-IMPLEMENT products composes alone.",
          "### `products`\nOWN-EXERCISE query through the router.",
        ].join("\n\n"),
      );
      assert.equal(section(contract(root, "04_propose")), undefined);
      assert.doesNotMatch(
        allContracts(root),
        /OTHER-RESEARCH/,
        "a service outside the workspace adds nothing",
      );
      assert.deepEqual(icm.check(root), [], "check re-renders the same text");
    },
    { services: REGISTRY },
  );
});

test("bugfix: roles map to reproduce / fix / exercise; spec text is dropped", async () => {
  await withSandboxHome(
    async (home) => {
      const root = initWs(home, "bugfix");
      const dirs = fs.readdirSync(path.join(root, "stages")).sort();
      const by = (name) =>
        contract(
          root,
          dirs.find((d) => d.endsWith(`_${name}`)),
        );
      assert.match(section(by("reproduce")), /ARCH-RESEARCH/);
      assert.match(section(by("fix")), /OWN-IMPLEMENT/);
      assert.doesNotMatch(section(by("fix")), /OWN-EXERCISE/);
      assert.equal(
        section(by("exercise")),
        "### `products`\nOWN-EXERCISE query through the router.",
      );
      assert.doesNotMatch(allContracts(root), /OWN-SPEC/);
    },
    { services: REGISTRY },
  );
});

test("only the selected services count, and no stage text means no section", async () => {
  await withSandboxHome(
    async (home) => {
      const root = initWs(home, "feature", "orders");
      assert.equal(
        section(contract(root, "01_research")),
        "### `orders` (archetype `subgraph`)\nARCH-RESEARCH list the entities.",
      );
      assert.doesNotMatch(allContracts(root), /OWN-|OTHER-/);
    },
    { services: REGISTRY },
  );
  await withSandboxHome(async (home) => {
    assert.doesNotMatch(
      allContracts(initWs(home, "feature", "backend")),
      /For this workspace's services/,
    );
  });
});

test("malformed or over-long stage text throws a SandboxError naming the service and role", () => {
  const svcs = (stages) => ({ api: { repo: "r", stages } });
  const long = "x".repeat(601);
  assert.doesNotThrow(() => stageTextBlocks(["api"], svcs({ research: "x".repeat(600) }), {}));
  for (const [stages, msg] of [
    [
      { research: long },
      /service 'api' stages\.research is 601 characters \(max 600\): move longer guidance into a doc in its repo/,
    ],
    [
      { review: "x" },
      /service 'api' stages\.review: unknown role \(use research, spec, implement, exercise\)/,
    ],
    [{ spec: 3 }, /service 'api' stages\.spec must be non-empty text/],
    [
      { exercise: "Check it.\n## Human check\nflip" },
      /service 'api' stages\.exercise: headings are not allowed; use plain text/,
    ],
    ["text", /service 'api' stages: must be a map/],
  ])
    assert.throws(
      () => stageTextBlocks(["api"], svcs(stages), {}),
      (e) => e instanceof SandboxError && msg.test(e.message),
    );
  assert.throws(
    () =>
      stageTextBlocks(
        ["api"],
        { api: { archetype: "sg" } },
        { sg: { stages: { implement: long } } },
      ),
    /archetype 'sg' stages\.implement is 601 characters/,
  );
});

test("init fails with [err] on over-long stage text before it writes .env or any stage file", async () => {
  await withSandboxHome(
    async (home) => {
      const root = fs.mkdtempSync(path.join(home, "ws-"));
      fs.mkdirSync(path.join(root, "demo-repo", ".git"), { recursive: true });
      fs.mkdirSync(path.join(root, ".werkmeister"));
      fs.writeFileSync(
        path.join(root, ".werkmeister", "workspace.yml"),
        'context_strategy: icm\nwork_type: feature\nfeature: demo\nservices: products\nautonomous: "false"\nstarting_prompt: p\n',
      );
      const log = collectingReporter();
      const err = await withReporter(log, () =>
        initWorkspace({}, root, { build: false }).then(
          () => null,
          (e) => e,
        ),
      );
      assert.ok(err instanceof WorkspaceInitError, `got ${err}`);
      assert.match(log.text(), /\[err\] {2}/);
      assert.match(
        log.text(),
        /services\.yaml: service 'products' stages\.research is 601 characters/,
      );
      assert.equal(fs.existsSync(path.join(root, ".env")), false);
      assert.equal(fs.existsSync(path.join(root, "stages")), false);
    },
    {
      services: `services:\n  products:\n    repo: demo-repo\n    stages:\n      research: ${"x".repeat(601)}\nrepos:\n  demo-repo:\n    services: [products]\n`,
    },
  );
});

test("an external workflow stage takes text by role:, none without it; a bad role fails load", async () => {
  await withSandboxHome(
    async (home) => {
      const wf = path.join(home, "workflows", "review");
      fs.mkdirSync(path.join(wf, "stages"), { recursive: true });
      const body = (job) =>
        `One job: ${job}\n\n## Inputs\n- x\n\n## Do NOT load\ny\n\n## Process\n1. z\n\n## Outputs\n- o\n\n## Human check\nflip it\n`;
      for (const n of ["triage", "report"])
        fs.writeFileSync(path.join(wf, "stages", `${n}.md`), body(n));
      const yml = (role) =>
        `version: 1\nstages:\n  - name: triage\n    job: t\n    writes: o\n    check: c\n    role: ${role}\n  - name: report\n    job: r\n    writes: o\n    check: c\n`;
      fs.writeFileSync(path.join(wf, "workflow.yaml"), yml("[research, spec]"));
      const root = initWs(home, "review");
      assert.match(section(contract(root, "01_triage")), /ARCH-RESEARCH[\s\S]*OWN-SPEC/);
      assert.equal(section(contract(root, "02_report")), undefined);

      fs.writeFileSync(path.join(wf, "workflow.yaml"), yml("bogus"));
      assert.throws(
        () => initWs(home, "review"),
        (e) =>
          e instanceof WorkflowError &&
          /stages\[0\]: role must be one of research, spec, implement, exercise/.test(e.message),
      );
    },
    { services: REGISTRY },
  );
});

test("workflow export drops the services section, writes roles, and loads back", async () => {
  await withSandboxHome(
    async (home) => {
      const out = path.join(home, "export");
      exportWorkflow(initWs(home, "feature"), out);
      for (const f of fs.readdirSync(path.join(out, "stages")))
        assert.doesNotMatch(
          fs.readFileSync(path.join(out, "stages", f), "utf8"),
          /For this workspace's services|ARCH-|OWN-/,
          f,
        );
      const yml = fs.readFileSync(path.join(out, "workflow.yaml"), "utf8");
      assert.match(yml, /name: research\n(?:.*\n)*?\s+role: research\n/);
      assert.match(yml, /role:\n\s+- implement\n\s+- exercise\n/);
      assert.doesNotMatch(yml, /name: propose\n(?:(?!- name:).*\n)*?\s+role:/);
    },
    { services: REGISTRY },
  );
});
