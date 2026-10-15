// The prompt chain moved out of the CLI (note 087: core never drives the CLI),
// so the wiring that used to be proven by `sandbox workspace --print-form-schema`
// running end-to-end is pinned here instead: the spec carries every wizard field,
// `repos` lands right after `services`, and the spec still converts to a form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildFormSchema } from "./dist/form_schema.js";
import { writeWorkspaceConfig } from "./dist/workspace_init.js";

import {
  computePromptSpec,
  DEFAULT_PLAN,
  promptEntry,
  readAutonomous,
  resolveInputs,
  WORK_TYPE_PHASES,
  planFor,
} from "./dist/workspace_prompts.js";

// The machine's config.yaml would leak in: `overrides.issue_tracker: github`
// rewords and re-validates the `issue_id` prompt.
process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";

// An empty dir: no workspace.yml to pre-resolve fields, no repos to scrape.
const root = await mkdtemp(path.join(tmpdir(), "prompt-spec-"));

test("the spec carries the wizard prompts, with repos spliced after services", () => {
  const spec = computePromptSpec({}, root);
  const keys = spec.prompts.map((p) => p.key);
  assert.deepEqual(keys.filter((k) => k !== "repos"), [
    "issue_id",
    "feature",
    "work_type",
    "context_strategy",
    "autonomous",
    "services",
    "labels",
    "test_path",
    "task",
    "description",
    "starting_prompt",
  ]);
  // `repos` is only offered when repos.yaml lists any, so it may be absent.
  if (keys.includes("repos")) {
    assert.equal(keys.indexOf("repos"), keys.indexOf("services") + 1);
  }
});

test("a CLI flag resolves its field out of the form", () => {
  const spec = computePromptSpec({ feature: "mdx-blog" }, root);
  const feature = spec.prompts.find((p) => p.key === "feature");
  assert.equal(feature.resolved, true);
  assert.equal(feature.resolved_value, "mdx-blog");
  assert.ok(!("feature" in buildFormSchema(spec).schema.properties));
});

test("the spec converts to a form schema", () => {
  const { schema, uiSchema } = buildFormSchema(computePromptSpec({}, root));
  assert.equal(schema.properties.work_type.enum.includes("bugfix"), true);
  assert.equal(uiSchema.starting_prompt["ui:widget"], "textarea");
  assert.deepEqual(schema.required, ["feature", "work_type"]);
});

test("choice groups reach the form schema as ui:options.groups", () => {
  const entry = promptEntry(
    {
      key: "services",
      label: "Services",
      help: "h",
      multi: true,
      choicesFn: () => ["api", "cron", "web"],
      choiceGroupsFn: () => ({ web: "repo-b", api: "repo-a" }),
    },
    root,
    {},
  );
  assert.deepEqual(entry.choice_groups, { other: ["cron"], "repo-a": ["api"], "repo-b": ["web"] });
  const { uiSchema } = buildFormSchema({ prompts: [entry] });
  assert.deepEqual(uiSchema.services["ui:options"].groups, entry.choice_groups);
});

test("context_strategy is an optional select defaulting to jit", () => {
  const spec = computePromptSpec({}, root);
  const prompt = spec.prompts.find((p) => p.key === "context_strategy");
  assert.equal(prompt.default, "jit");
  assert.equal(prompt.accept_empty, true);
  const { schema } = buildFormSchema(spec);
  assert.ok(!schema.required.includes("context_strategy"));
});

test("autonomous is an optional checkbox, off by default", () => {
  const { schema, formData } = buildFormSchema(computePromptSpec({}, root));
  assert.equal(schema.properties.autonomous.type, "boolean");
  assert.equal(formData.autonomous, false);
  assert.ok(!schema.required.includes("autonomous"));
});

/** A workspace root whose workspace.yml holds *yml*. */
function wsWith(yml) {
  const ws = mkdtempSync(path.join(tmpdir(), "autonomous-"));
  mkdirSync(path.join(ws, ".sandbox"));
  writeFileSync(path.join(ws, ".sandbox", "workspace.yml"), yml);
  return ws;
}

test("autonomous resolves from the flag, the env var and workspace.yml, as true/false", () => {
  assert.equal(resolveInputs({ autonomous: true }, root).autonomous, "true");
  assert.equal(resolveInputs({}, wsWith("autonomous: true\n")).autonomous, "true");
  assert.equal(resolveInputs({}, wsWith("autonomous: false\n")).autonomous, "false");
  assert.ok(!("autonomous" in resolveInputs({}, root)));
  process.env.SANDBOX_AUTONOMOUS = "1";
  try {
    assert.equal(resolveInputs({}, wsWith("autonomous: false\n")).autonomous, "true");
  } finally {
    delete process.env.SANDBOX_AUTONOMOUS;
  }
});

test("readAutonomous reads workspace.yml; absent is off", () => {
  assert.equal(readAutonomous(wsWith("autonomous: true\n")), true);
  assert.equal(readAutonomous(wsWith("autonomous: false\n")), false);
  assert.equal(readAutonomous(root), false);
});

test("workspace.yml stores autonomous as a YAML boolean", () => {
  const ws = wsWith("feature: x\n");
  writeWorkspaceConfig(ws, { autonomous: "true" });
  assert.match(readFileSync(path.join(ws, ".sandbox", "workspace.yml"), "utf8"), /^autonomous: true$/m);
});

// `getFormSchema` builds the spec against $HOME and discards every default, so
// the issue default's `git` scan of each subdirectory was pure cost
// (known-issues.md, "getFormSchema() Scans Your Home Directory").
test("defaults: false skips the issue scan of the root's repos", () => {
  const scanned = mkdtempSync(path.join(tmpdir(), "prompt-defaults-"));
  const repo = path.join(scanned, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/PROJ-7-thing"], { cwd: repo });

  const issueDefault = (opts) =>
    computePromptSpec({}, scanned, opts).prompts.find((p) => p.key === "issue_id").default;
  assert.equal(issueDefault(undefined), "PROJ-7");
  assert.equal(issueDefault({ defaults: false }), "");
});

const PHASES = ["research", "implement", "test", "review", "pr"];

test("every work type has phases, all drawn from the five", () => {
  for (const [type, plan] of Object.entries(WORK_TYPE_PHASES)) {
    assert.ok(plan.phases.length > 0, type);
    for (const phase of plan.phases) assert.ok(PHASES.includes(phase), `${type}: ${phase}`);
  }
});

test("refactor skips research; spike is research only", () => {
  assert.ok(!WORK_TYPE_PHASES.refactor.phases.includes("research"));
  assert.deepEqual(WORK_TYPE_PHASES.spike.phases, ["research"]);
});

test("planFor normalises the type and never returns a prototype member", () => {
  assert.equal(planFor(" Feature "), WORK_TYPE_PHASES.feature);
  assert.equal(planFor("nonsense"), DEFAULT_PLAN);
  assert.equal(planFor(""), DEFAULT_PLAN);
  assert.equal(planFor("constructor"), DEFAULT_PLAN);
});
