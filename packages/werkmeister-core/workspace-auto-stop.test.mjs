// The opt-in `auto_stop` (#231): workspace.yml → the managed SessionEnd hook in
// settings.json, the idle check behind `werkmeister internal session-end` and the create
// form. werkmeister-context.md's line is in werkmeister-context.test.mjs.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/config.js";
import { buildFormSchema } from "./dist/form_schema.js";
import {
  buildAgentStateEntry,
  buildSessionEndEntry,
  writeWorkspaceSettings,
} from "./dist/hooks_gen.js";
import { idleStopFeature } from "./dist/lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { writeWorkspaceConfig } from "./dist/workspace_init.js";
import { computePromptSpec, readAutoStop } from "./dist/workspace_prompts.js";

process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";

function workspace(yml, settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-auto-stop-"));
  if (yml !== undefined) setYml(root, yml);
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify(settings));
  }
  return root;
}

function setYml(root, yml) {
  fs.mkdirSync(dotDir(root), { recursive: true });
  fs.writeFileSync(path.join(dotDir(root), "workspace.yml"), yml);
}

const readHooks = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).hooks ?? {};

const USER_END = { hooks: [{ type: "command", command: "echo bye" }] };
const USER_PRE = { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] };
// Every workspace also gets the agent-state hook on SessionEnd and PreToolUse (SW-46).
const AGENT = buildAgentStateEntry();

test("auto_stop on: one managed SessionEnd entry, user entries kept, no duplicate on re-init", () => {
  const root = workspace("feature: f\nauto_stop: true\n", {
    hooks: { SessionEnd: [USER_END], PreToolUse: [USER_PRE] },
  });
  writeWorkspaceSettings(root);
  writeWorkspaceSettings(root);
  const hooks = readHooks(root);
  assert.deepEqual(hooks.SessionEnd, [USER_END, buildSessionEndEntry(), AGENT]);
  assert.deepEqual(hooks.PreToolUse, [USER_PRE, AGENT]);
  assert.match(hooks.SessionEnd[1].hooks[0].command, /werkmeister internal session-end/);
  assert.equal(hooks.SessionEnd[1].hooks[0].timeout, 10);
});

test("SW-186: hooks written with the pre-rename spellings are replaced, not doubled", () => {
  const pre186 = (entry) =>
    JSON.parse(
      JSON.stringify(entry)
        .replace("werkmeister internal session-end", "werkmeister stop --if-idle")
        .replace(/werkmeister internal (gate|pr-guard|agent-state)/g, "werkmeister hooks $1"),
    );
  const root = workspace("feature: f\nauto_stop: true\n", {
    hooks: {
      SessionEnd: [USER_END, pre186(buildSessionEndEntry()), pre186(AGENT)],
      PreToolUse: [USER_PRE, pre186(AGENT)],
    },
  });
  writeWorkspaceSettings(root);
  const hooks = readHooks(root);
  assert.deepEqual(hooks.SessionEnd, [USER_END, buildSessionEndEntry(), AGENT]);
  assert.deepEqual(hooks.PreToolUse[0], USER_PRE);
  assert.equal(hooks.PreToolUse.filter((e) => JSON.stringify(e).includes("agent-state")).length, 1);
  const text = JSON.stringify(hooks);
  assert.ok(!/werkmeister (hooks |stop --if-idle)/.test(text), text);
});

test("auto_stop off: the managed entry is removed, the user's stays", () => {
  const root = workspace("feature: f\nauto_stop: true\n", { hooks: { SessionEnd: [USER_END] } });
  writeWorkspaceSettings(root);
  setYml(root, "feature: f\nauto_stop: false\n");
  writeWorkspaceSettings(root);
  assert.deepEqual(readHooks(root).SessionEnd, [USER_END, AGENT]);
});

test("auto_stop missing: no auto-stop hook is written, and a lone managed one goes", () => {
  const root = workspace("feature: f\n");
  writeWorkspaceSettings(root);
  assert.deepEqual(readHooks(root).SessionEnd, [AGENT]);

  setYml(root, "feature: f\nauto_stop: true\n");
  writeWorkspaceSettings(root);
  setYml(root, "feature: f\n");
  writeWorkspaceSettings(root);
  assert.deepEqual(readHooks(root).SessionEnd, [AGENT]);
});

/** A workspace whose hooks recorded these session ids (SW-182), plus junk to skip. */
function workspaceWith(...ids) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "auto-stop-ws-"));
  const at = new Date().toISOString();
  const sessions = Object.fromEntries(ids.map((id) => [id, { status: "idle", at }]));
  sessions.junk = { status: 7 };
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "agent-state.json"), JSON.stringify({ sessions }));
  return ws;
}

const idle = (over) =>
  idleStopFeature({
    feature: "demo",
    workspaceRoot: "/nonexistent/ws",
    sessionId: "ending",
    reason: "prompt_input_exit",
    entrypoint: "claude-desktop",
    ...over,
  });

test("--if-idle stops only when no other live session is in the workspace", () => {
  assert.equal(idle({}), "demo");
  assert.equal(idle({ workspaceRoot: workspaceWith() }), "demo");
  assert.equal(
    idle({ workspaceRoot: workspaceWith("ending") }),
    "demo",
    "the ending session itself",
  );
  assert.equal(idle({ workspaceRoot: workspaceWith("ending", "other") }), null);
});

test("--if-idle leaves the feature up when the session carries on or is headless", () => {
  assert.equal(idle({ reason: "clear" }), null);
  assert.equal(idle({ reason: "resume" }), null);
  assert.equal(idle({ entrypoint: "sdk-cli" }), null);
  assert.equal(idle({ reason: null, entrypoint: null }), "demo");
});

test("--if-idle never targets infra, and needs a feature", () => {
  assert.equal(idle({ feature: "infra" }), null);
  assert.equal(idle({ feature: undefined }), null);
  assert.equal(idle({ feature: "" }), null);
});

test("the form has an auto_stop checkbox, off by default; workspace.yml stores a boolean", async () => {
  const { schema, formData } = buildFormSchema(
    computePromptSpec({}, workspace(), { defaults: false }),
  );
  assert.equal(schema.properties.auto_stop.type, "boolean");
  assert.equal(formData.auto_stop, false);
  assert.ok(!(schema.required ?? []).includes("auto_stop"));

  const root = workspace();
  await withReporter(collectingReporter(), async () =>
    writeWorkspaceConfig(root, { feature: "f", auto_stop: "true" }),
  );
  assert.match(
    fs.readFileSync(path.join(dotDir(root), "workspace.yml"), "utf8"),
    /^auto_stop: true$/m,
  );
  assert.equal(readAutoStop(root), true);
});

test("auto_stop unset follows autonomous; an explicit value wins (SW-39)", () => {
  assert.equal(readAutoStop(workspace("feature: f\nautonomous: true\n")), true);
  assert.equal(readAutoStop(workspace("feature: f\nautonomous: false\n")), false);
  assert.equal(readAutoStop(workspace("feature: f\n")), false);
  assert.equal(readAutoStop(workspace("feature: f\nautonomous: true\nauto_stop: false\n")), false);
  assert.equal(readAutoStop(workspace("feature: f\nauto_stop: true\n")), true);

  const root = workspace("feature: f\nautonomous: true\n");
  writeWorkspaceSettings(root);
  assert.deepEqual(
    readHooks(root).SessionEnd,
    [buildSessionEndEntry(), AGENT],
    "auto-stop is written",
  );
});

test("an unticked auto_stop leaves a new workspace.yml unset but turns an existing one off (SW-39)", async () => {
  const yml = (root) => fs.readFileSync(path.join(dotDir(root), "workspace.yml"), "utf8");
  const fresh = workspace();
  await withReporter(collectingReporter(), async () =>
    writeWorkspaceConfig(fresh, { feature: "f", autonomous: "true", auto_stop: "false" }),
  );
  assert.doesNotMatch(yml(fresh), /auto_stop/);
  assert.equal(readAutoStop(fresh), true);

  const on = workspace("feature: f\nauto_stop: true\n");
  await withReporter(collectingReporter(), async () =>
    writeWorkspaceConfig(on, { feature: "f", auto_stop: "false" }),
  );
  assert.match(yml(on), /^auto_stop: false$/m);
});
