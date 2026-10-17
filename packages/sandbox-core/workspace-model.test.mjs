// The per-workspace `model` (#233): workspace.yml → settings.json (only ever
// replacing or removing a value sandbox recorded), the claude-send / claude-resume
// commands, and the create form.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildFormSchema } from "./dist/form_schema.js";
import { writeWorkspaceModel, writeWorkspacePermissions } from "./dist/hooks_gen.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { claudeResumeCommand, claudeSendArgs } from "./dist/sandbox.js";
import { writeWorkspaceConfig } from "./dist/workspace_init.js";
import { _WIZARD_PROMPTS, computePromptSpec, readModel } from "./dist/workspace_prompts.js";

process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";

function workspace(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-model-"));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(settingsPath(root), JSON.stringify(settings));
  }
  return root;
}

const settingsPath = (root) => path.join(root, ".claude", "settings.json");
const recordPath = (root) => path.join(root, ".sandbox", "claude-permissions.json");
const readSettings = (root) => JSON.parse(fs.readFileSync(settingsPath(root), "utf8"));
const readRecord = (root) => JSON.parse(fs.readFileSync(recordPath(root), "utf8"));

test("the model lands in settings.json and the record; a second write changes nothing", () => {
  const root = workspace({ hooks: {} });
  writeWorkspaceModel(root, "sonnet");
  assert.deepEqual(readSettings(root), { hooks: {}, model: "sonnet" });
  assert.deepEqual(readRecord(root), { model: "sonnet" });
  const old = new Date(2000, 0, 1);
  fs.utimesSync(settingsPath(root), old, old);
  fs.utimesSync(recordPath(root), old, old);
  writeWorkspaceModel(root, "sonnet");
  assert.equal(fs.statSync(settingsPath(root)).mtimeMs, old.getTime());
  assert.equal(fs.statSync(recordPath(root)).mtimeMs, old.getTime());
});

test("changing and clearing replace and remove only the recorded model", () => {
  const root = workspace({ hooks: {} });
  writeWorkspaceModel(root, "sonnet");
  writeWorkspaceModel(root, "haiku");
  assert.equal(readSettings(root).model, "haiku");
  writeWorkspaceModel(root, null);
  assert.deepEqual(readSettings(root), { hooks: {} });
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("a model set by hand survives setting and clearing, and is never recorded", () => {
  const root = workspace({ model: "opus" });
  writeWorkspaceModel(root, "sonnet");
  assert.equal(readSettings(root).model, "opus");
  assert.ok(!fs.existsSync(recordPath(root)));
  writeWorkspaceModel(root, null);
  assert.equal(readSettings(root).model, "opus");
});

test("the person editing a recorded model makes it theirs", () => {
  const root = workspace();
  writeWorkspaceModel(root, "sonnet");
  fs.writeFileSync(settingsPath(root), JSON.stringify({ model: "opus" }));
  writeWorkspaceModel(root, null);
  assert.equal(readSettings(root).model, "opus");
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("allow rules and the model share the record without dropping each other", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a"]);
  writeWorkspaceModel(root, "sonnet");
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readRecord(root), { allow: ["a", "b"], model: "sonnet" });
  writeWorkspacePermissions(root, []);
  assert.deepEqual(readRecord(root), { model: "sonnet" });
  assert.deepEqual(readSettings(root), { model: "sonnet" });
  writeWorkspaceModel(root, null);
  assert.ok(!fs.existsSync(recordPath(root)));
  assert.ok(!fs.existsSync(settingsPath(root)));
});

test("no model: nothing is created", () => {
  const root = workspace();
  writeWorkspaceModel(root, null);
  assert.ok(!fs.existsSync(path.join(root, ".claude")));
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("claude-send passes --model only when the workspace has one", () => {
  assert.deepEqual(claudeSendArgs("hi", null, null), [
    "-p",
    "--permission-mode",
    "acceptEdits",
    "hi",
  ]);
  assert.deepEqual(claudeSendArgs("hi", "s1", "sonnet"), [
    "-p",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "sonnet",
    "--resume",
    "s1",
    "hi",
  ]);
});

test("claude-resume passes a quoted --model only when the workspace has one", () => {
  assert.equal(claudeResumeCommand(null, null), "claude");
  assert.equal(claudeResumeCommand("s1", null), "claude --resume s1");
  assert.equal(claudeResumeCommand("s1", "sonnet"), "claude --model 'sonnet' --resume s1");
  assert.equal(claudeResumeCommand(null, "sonnet[1m]"), "claude --model 'sonnet[1m]'");
});

test("workspace.yml persists the model and readModel reads it back", async () => {
  const root = workspace();
  await withReporter(collectingReporter(), async () =>
    writeWorkspaceConfig(root, { feature: "f", model: "sonnet" }),
  );
  assert.match(
    fs.readFileSync(path.join(root, ".sandbox", "workspace.yml"), "utf8"),
    /^model: sonnet$/m,
  );
  assert.equal(readModel(root), "sonnet");
  fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), 'feature: f\nmodel: ""\n');
  assert.equal(readModel(root), null);
});

test("the form gets model right after autonomous: an optional string with a one-token pattern", () => {
  const keys = _WIZARD_PROMPTS.map((p) => p.key);
  assert.equal(keys.indexOf("model"), keys.indexOf("autonomous") + 1);
  const { schema } = buildFormSchema(computePromptSpec({}, workspace(), { defaults: false }));
  const field = schema.properties.model;
  assert.equal(field.type, "string");
  assert.ok(!(schema.required ?? []).includes("model"));
  const re = new RegExp(field.pattern);
  // Blank passes: an optional field's pattern also admits "" (Claude Code's default).
  for (const ok of ["", "sonnet", "claude-opus-5-5", "sonnet[1m]"]) assert.ok(re.test(ok), ok);
  for (const bad of ["bad model", "x;rm", "-p"]) assert.ok(!re.test(bad), bad);
});
