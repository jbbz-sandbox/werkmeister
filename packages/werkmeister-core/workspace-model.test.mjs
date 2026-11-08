// The per-workspace `model` (#233): workspace.yml → settings.json (only ever
// replacing or removing a value sandbox recorded), the claude-send / claude-resume
// commands, and the create form.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/config.js";
import { buildFormSchema } from "./dist/form_schema.js";
import { writeWorkspaceModel, writeWorkspacePermissions } from "./dist/harness/claude/hooks_gen.js";
import { deniedIn } from "./dist/harness/claude/session.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { claudeResumeCommand, claudeSendArgs } from "./dist/sandbox.js";
import { writeWorkspaceConfig } from "./dist/workspace_init.js";
import {
  _WIZARD_PROMPTS,
  computePromptSpec,
  readModel,
  resolveInputs,
  resolveModelInput,
} from "./dist/workspace_prompts.js";

process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";

function workspace(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-model-"));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(settingsPath(root), JSON.stringify(settings));
  }
  return root;
}

const settingsPath = (root) => path.join(root, ".claude", "settings.json");
const recordPath = (root) => path.join(dotDir(root), "claude-permissions.json");
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

test("an unattended turn's rules come before the next flag, so the body stays the prompt (SW-313)", () => {
  assert.deepEqual(
    claudeSendArgs("fix it", "s1", null, {
      allow: ["Bash(git:*)", "Bash(gh pr checks:*)"],
      deny: ["Bash(werkmeister down:*)"],
      json: true,
    }),
    [
      "-p",
      "--allowedTools",
      "Bash(git:*),Bash(gh pr checks:*)",
      "--disallowedTools",
      "Bash(werkmeister down:*)",
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "json",
      "--resume",
      "s1",
      "fix it",
    ],
  );
});

test("deniedIn: each refused call once, as tool: first line of its command", () => {
  const out = JSON.stringify({
    subtype: "success",
    permission_denials: [
      { tool_name: "Bash", tool_input: { command: "pnpm run test\necho done" } },
      { tool_name: "Bash", tool_input: { command: "pnpm run test\necho done" } },
      { tool_name: "mcp__github__pull_request_read", tool_input: { pullNumber: 585 } },
    ],
  });
  assert.deepEqual(deniedIn(out), ["Bash: pnpm run test", "mcp__github__pull_request_read"]);
  assert.deepEqual(deniedIn("not json"), []);
  assert.deepEqual(deniedIn(JSON.stringify({ subtype: "success" })), []);
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
  // SW-577: the default tier's model, now always set, reaches the command line too.
  assert.equal(claudeResumeCommand(null, "opus"), "claude --model 'opus'");
  assert.ok(claudeSendArgs("hi", null, "opus").join(" ").includes("--model opus"));
  assert.equal(
    claudeResumeCommand("s1", null, "start the run"),
    "claude --resume s1 'start the run'",
  );
  assert.equal(claudeResumeCommand(null, null, "it's"), "claude 'it'\\''s'");
  assert.equal(claudeResumeCommand(null, null, ""), "claude");
});

test("workspace.yml persists the model and readModel reads it back", async () => {
  const root = workspace();
  await withReporter(collectingReporter(), async () =>
    writeWorkspaceConfig(root, { feature: "f", model: "sonnet" }),
  );
  assert.match(
    fs.readFileSync(path.join(dotDir(root), "workspace.yml"), "utf8"),
    /^model: sonnet$/m,
  );
  assert.equal(readModel(root), "sonnet");
  fs.writeFileSync(path.join(dotDir(root), "workspace.yml"), 'feature: f\nmodel: ""\n');
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
  // Blank passes: an optional field's pattern also admits "" (the default tier).
  for (const ok of [
    "",
    "sonnet",
    "claude-opus-5-5",
    "sonnet[1m]",
    "mid",
    "anthropic/claude-opus-5-5",
  ])
    assert.ok(re.test(ok), ok);
  for (const bad of ["bad model", "x;rm", "-p"]) assert.ok(!re.test(bad), bad);
});

// SW-577: create and init resolve the model once, so the run never falls to the harness default.
async function withConfig(yaml, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-model-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml);
  const saved = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = file;
  try {
    return await fn(file);
  } finally {
    process.env.WERKMEISTER_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What create and init record: the inputs, then the model resolved from them. */
const recorded = (args, root) => {
  const inputs = resolveInputs(args, root);
  resolveModelInput(inputs);
  return inputs;
};

test("SW-577: no --model and no models: block resolves to the built-in frontier model, opus", () => {
  assert.equal(recorded({ feature: "f" }, workspace()).model, "opus");
  assert.equal(
    recorded({ feature: "f", harness: "opencode" }, workspace()).model,
    "anthropic/claude-opus-5-5",
  );
  assert.equal(recorded({ feature: "f", harness: "mcp" }, workspace()).model, undefined);
  // The create form still asks: resolveInputs leaves a blank model unset.
  assert.equal(resolveInputs({ feature: "f" }, workspace()).model, undefined);
});

test("SW-577: --model mid resolves through config.yaml; a later config change leaves the recorded model", async () => {
  const root = workspace();
  await withConfig("models:\n  claude:\n    mid: haiku\n", async (file) => {
    const inputs = recorded({ feature: "f", model: "mid" }, root);
    assert.equal(inputs.model, "haiku");
    await withReporter(collectingReporter(), async () => writeWorkspaceConfig(root, inputs));
    fs.writeFileSync(file, "models:\n  claude:\n    mid: sonnet\n");
    assert.equal(recorded({}, root).model, "haiku");
    assert.equal(recorded({ feature: "g", model: "mid" }, workspace()).model, "sonnet");
  });
});

test("SW-577: an explicit model passes through; a tier with no model for the harness throws naming the key", () => {
  assert.equal(
    recorded({ feature: "f", model: "claude-opus-5-5" }, workspace()).model,
    "claude-opus-5-5",
  );
  assert.throws(
    () => recorded({ feature: "f", harness: "codex" }, workspace()),
    /set models\.codex\.frontier in ~\/\.werkmeister\/config\.yaml/,
  );
});
