import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFolders } from "./merge-folders.mjs";

const existing = [
  { name: "sandbox", path: "/repo/sandbox" }, // manual (no source)
  { name: "claudeck-test", path: "/ws/claudeck-test" }, // manual
  { name: "gone", path: "/ws/gone", source: "sandbox" }, // stale managed
];
const workspaces = [
  { name: "test-me", path: "/ws/test-me", jiraUrl: "https://j/PROJ-1" },
  { name: "claudeck-test", path: "/ws/claudeck-test", jiraUrl: null },
];

test("adds managed workspace entries with source marker", () => {
  const out = mergeFolders(existing, workspaces);
  const tm = out.find((e) => e.path === "/ws/test-me");
  assert.deepEqual(tm, { name: "test-me", path: "/ws/test-me", source: "sandbox" });
});

test("preserves manual entries and prunes stale managed", () => {
  const out = mergeFolders(existing, workspaces);
  assert.ok(out.some((e) => e.path === "/repo/sandbox" && !e.source));
  assert.ok(out.some((e) => e.path === "/ws/claudeck-test" && !e.source));
  assert.ok(!out.some((e) => e.path === "/ws/gone")); // stale managed pruned
});

test("dedupes: workspace whose path is a manual entry is not re-added as managed", () => {
  const out = mergeFolders(existing, workspaces);
  // claudeck-test path is a manual entry -> no managed duplicate for it
  const claudeckEntries = out.filter((e) => e.path === "/ws/claudeck-test");
  assert.equal(claudeckEntries.length, 1);
  assert.equal(claudeckEntries[0].source, undefined);
});

test("is idempotent", () => {
  const once = mergeFolders(existing, workspaces);
  const twice = mergeFolders(once, workspaces);
  assert.deepEqual(twice, once);
});

test("defaults to [] on non-array input", () => {
  assert.deepEqual(mergeFolders(undefined, []), []);
});
