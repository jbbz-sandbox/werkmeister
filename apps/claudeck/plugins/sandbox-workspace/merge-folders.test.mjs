import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFolders } from "./merge-folders.mjs";

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
