import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFolders, workspaceNameForPath } from "./dist/folders.js";

const ROOT = "/ws";
const existing = [
  { name: "sandbox", path: "/repo/sandbox" }, // manual, outside the root
  { name: "claudeck-test", path: "/ws/claudeck-test" }, // manual, still live
  { name: "feature-2", path: "/ws/feature-2" }, // manual, workspace gone
  { name: "gone", path: "/ws/gone", source: "sandbox" }, // stale managed
];
const workspaces = [
  { name: "test-me", path: "/ws/test-me", jiraUrl: "https://j/PROJ-1" },
  { name: "claudeck-test", path: "/ws/claudeck-test", jiraUrl: null },
];

test("adds managed workspace entries with source marker", () => {
  const out = mergeFolders(existing, workspaces, ROOT);
  const tm = out.find((e) => e.path === "/ws/test-me");
  assert.deepEqual(tm, { name: "test-me", path: "/ws/test-me", source: "sandbox" });
});

test("preserves manual entries and prunes stale managed", () => {
  const out = mergeFolders(existing, workspaces, ROOT);
  assert.ok(out.some((e) => e.path === "/repo/sandbox" && !e.source));
  assert.ok(out.some((e) => e.path === "/ws/claudeck-test" && !e.source));
  assert.ok(!out.some((e) => e.path === "/ws/gone")); // stale managed pruned
});

test("prunes unmarked entries whose workspace under the root is gone", () => {
  const out = mergeFolders(existing, workspaces, ROOT);
  assert.ok(!out.some((e) => e.path === "/ws/feature-2"));
});

test("empty workspaces root clears every workspace entry", () => {
  const out = mergeFolders(existing, [], ROOT);
  assert.deepEqual(out, [{ name: "sandbox", path: "/repo/sandbox" }]);
});

test("dedupes: workspace whose path is a manual entry is not re-added as managed", () => {
  const out = mergeFolders(existing, workspaces, ROOT);
  // claudeck-test path is a manual entry -> no managed duplicate for it
  const claudeckEntries = out.filter((e) => e.path === "/ws/claudeck-test");
  assert.equal(claudeckEntries.length, 1);
  assert.equal(claudeckEntries[0].source, undefined);
});

test("is idempotent", () => {
  const once = mergeFolders(existing, workspaces, ROOT);
  const twice = mergeFolders(once, workspaces, ROOT);
  assert.deepEqual(twice, once);
});

test("defaults to [] on non-array input", () => {
  assert.deepEqual(mergeFolders(undefined, [], ROOT), []);
});

// The reverse lookup the /open route uses: claudeck holds a project path,
// sandbox-core's workspace calls are keyed on a name.
test("finds the workspace name for a project path", () => {
  assert.equal(workspaceNameForPath(workspaces, "/ws/test-me"), "test-me");
});

test("normalises the path it is given", () => {
  assert.equal(workspaceNameForPath(workspaces, "/ws/test-me/"), "test-me");
  assert.equal(workspaceNameForPath(workspaces, "/ws/other/../test-me"), "test-me");
});

test("is null for a project that is not a workspace", () => {
  // A manual claudeck entry outside the workspaces root — the case that made
  // basename() the wrong answer.
  assert.equal(workspaceNameForPath(workspaces, "/repo/sandbox"), null);
  // Same basename, different place.
  assert.equal(workspaceNameForPath(workspaces, "/elsewhere/test-me"), null);
  assert.equal(workspaceNameForPath(workspaces, ""), null);
  assert.equal(workspaceNameForPath(undefined, "/ws/test-me"), null);
});

// The two halves have to agree, or /open 400s on a project the picker offered.
test("resolves every path mergeFolders writes as managed", () => {
  for (const entry of mergeFolders(existing, workspaces, ROOT)) {
    if (entry.source !== "sandbox") continue;
    assert.equal(workspaceNameForPath(workspaces, entry.path), entry.name);
  }
});
