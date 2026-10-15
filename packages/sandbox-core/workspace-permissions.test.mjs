// The workspace's permissions.allow merge: adds once, keeps the person's rules,
// and removes only what sandbox recorded adding.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAllowRules,
  READ_ONLY_GIT_RULES,
  removeWorkspacePermissions,
  workspaceAllowRules,
  writeWorkspacePermissions,
} from "./dist/hooks_gen.js";

const HAND_HOOK = { hooks: [{ type: "command", command: "echo mine" }] };

function workspace(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-perms-"));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(settingsPath(root), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return root;
}

const settingsPath = (root) => path.join(root, ".claude", "settings.json");
const recordPath = (root) => path.join(root, ".sandbox", "claude-permissions.json");
const readSettings = (root) => JSON.parse(fs.readFileSync(settingsPath(root), "utf8"));
const readRecord = (root) => JSON.parse(fs.readFileSync(recordPath(root), "utf8"));

test("no .claude/: the rules land in a new settings.json and the record", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readSettings(root), { permissions: { allow: ["a", "b"] } });
  assert.deepEqual(readRecord(root), { allow: ["a", "b"] });
});

test("other keys, hooks, deny rules and the person's allow rules are kept", () => {
  const root = workspace({
    model: "opus",
    hooks: { PreToolUse: [HAND_HOOK] },
    permissions: { deny: ["Bash(rm:*)"], allow: ["mine"] },
  });
  writeWorkspacePermissions(root, ["a"]);
  assert.deepEqual(readSettings(root), {
    model: "opus",
    hooks: { PreToolUse: [HAND_HOOK] },
    permissions: { deny: ["Bash(rm:*)"], allow: ["mine", "a"] },
  });
  assert.deepEqual(readRecord(root), { allow: ["a"] });
});

test("a second write adds nothing and leaves both files untouched", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a", "b"]);
  const old = new Date(2000, 0, 1);
  fs.utimesSync(settingsPath(root), old, old);
  fs.utimesSync(recordPath(root), old, old);
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readSettings(root).permissions.allow, ["a", "b"]);
  assert.equal(fs.statSync(settingsPath(root)).mtimeMs, old.getTime());
  assert.equal(fs.statSync(recordPath(root)).mtimeMs, old.getTime());
});

test("a rule the person already had is not recorded, so removal keeps it", () => {
  const root = workspace({ permissions: { allow: ["a"] } });
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readSettings(root).permissions.allow, ["a", "b"]);
  assert.deepEqual(readRecord(root), { allow: ["b"] });
  removeWorkspacePermissions(root);
  assert.deepEqual(readSettings(root), { permissions: { allow: ["a"] } });
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("a rule sandbox added that is no longer wanted is dropped", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a", "b"]);
  writeWorkspacePermissions(root, ["b", "c"]);
  assert.deepEqual(readSettings(root).permissions.allow, ["b", "c"]);
  assert.deepEqual(readRecord(root), { allow: ["b", "c"] });
});

test("removal of the only content deletes settings.json, .claude/ and the record", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a"]);
  removeWorkspacePermissions(root);
  assert.ok(!fs.existsSync(path.join(root, ".claude")));
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("removal keeps hooks and drops the emptied permissions key", () => {
  const root = workspace({ hooks: { PreToolUse: [HAND_HOOK] } });
  writeWorkspacePermissions(root, ["a"]);
  removeWorkspacePermissions(root);
  assert.deepEqual(readSettings(root), { hooks: { PreToolUse: [HAND_HOOK] } });
});

for (const [name, body] of [
  ["unparseable JSON", "{ not json"],
  ["permissions is an array", JSON.stringify({ permissions: [] })],
  ["allow is a string", JSON.stringify({ permissions: { allow: "x" } })],
]) {
  test(`${name}: settings.json is left untouched and nothing is recorded`, () => {
    const root = workspace(body);
    writeWorkspacePermissions(root, ["a"]);
    assert.equal(fs.readFileSync(settingsPath(root), "utf8"), body);
    assert.ok(!fs.existsSync(recordPath(root)));
  });
}

test("buildAllowRules: container form + bare prefix per command, then git; no rule invented", () => {
  assert.deepEqual(buildAllowRules("feat", ["svc", "nocmd"], { svc: { test: "npm test" }, nocmd: {} }, {}), [
    "Bash(docker exec feat-svc sh -c 'npm test')",
    "Bash(npm test:*)",
    ...READ_ONLY_GIT_RULES,
  ]);
});

test("buildAllowRules: an archetype's {service} template is expanded", () => {
  const rules = buildAllowRules("feat", ["api"], { api: { archetype: "node" } }, { node: { test: "npx turbo run test --filter={service}" } });
  assert.deepEqual(rules.slice(0, 2), [
    "Bash(docker exec feat-api sh -c 'npx turbo run test --filter=api')",
    "Bash(npx turbo run test --filter=api:*)",
  ]);
});

test("workspaceAllowRules: no .env means the git rules alone, without the registry", () => {
  assert.deepEqual(workspaceAllowRules(workspace()), READ_ONLY_GIT_RULES);
});

test("jit refresh writes its hooks and the same allow rules", async () => {
  const { strategyById } = await import("./dist/strategies/index.js");
  const root = workspace();
  strategyById("jit").refresh(root);
  const settings = readSettings(root);
  assert.ok(settings.hooks.SessionStart, "JIT SessionStart hook");
  assert.equal(settings.hooks.PreToolUse.length, 2, "standards gate + PR guard");
  assert.deepEqual(settings.permissions.allow, READ_ONLY_GIT_RULES);
});
