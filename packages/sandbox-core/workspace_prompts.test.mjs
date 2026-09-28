// The prompt chain moved out of the CLI (note 087: core never drives the CLI),
// so the wiring that used to be proven by `sandbox workspace --print-form-schema`
// running end-to-end is pinned here instead: the spec carries every wizard field,
// `repos` lands right after `services`, and the spec still converts to a form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildFormSchema } from "./dist/form_schema.js";
import { computePromptSpec } from "./dist/workspace_prompts.js";

// An empty dir: no workspace.yml to pre-resolve fields, no repos to scrape.
const root = await mkdtemp(path.join(tmpdir(), "prompt-spec-"));

test("the spec carries the wizard prompts, with repos spliced after services", () => {
  const spec = computePromptSpec({}, root);
  const keys = spec.prompts.map((p) => p.key);
  assert.deepEqual(keys.filter((k) => k !== "repos"), [
    "jira_id",
    "feature",
    "work_type",
    "context_strategy",
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

test("context_strategy is an optional select defaulting to jit", () => {
  const spec = computePromptSpec({}, root);
  const prompt = spec.prompts.find((p) => p.key === "context_strategy");
  assert.equal(prompt.default, "jit");
  assert.equal(prompt.accept_empty, true);
  const { schema } = buildFormSchema(spec);
  assert.ok(!schema.required.includes("context_strategy"));
});

// `getFormSchema` builds the spec against $HOME and discards every default, so
// the Jira default's `git` scan of each subdirectory was pure cost
// (known-issues.md, "getFormSchema() Scans Your Home Directory").
test("defaults: false skips the Jira scan of the root's repos", () => {
  const scanned = mkdtempSync(path.join(tmpdir(), "prompt-defaults-"));
  const repo = path.join(scanned, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/PROJ-7-thing"], { cwd: repo });

  const jiraDefault = (opts) =>
    computePromptSpec({}, scanned, opts).prompts.find((p) => p.key === "jira_id").default;
  assert.equal(jiraDefault(undefined), "PROJ-7");
  assert.equal(jiraDefault({ defaults: false }), "");
});
