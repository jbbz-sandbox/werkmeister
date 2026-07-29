// Smoke test for lib/workspace-search's dependency-free filterWorkspaces:
// substring matching, AND-combined multi-term queries, `-exclude` and
// `a|b` OR groups, the labels field, and empty-query passthrough with
// original-order preservation.
// Run: npm run build:server && node lib/workspace-search.smoke.mjs
import assert from "node:assert";

const { filterWorkspaces } = await import("../dist/lib/workspace-search.js");

const all = [
  { name: "proj-2165-pageview-500-fix", jiraId: "PROJ-2165", labels: ["urgent", "webapp"] },
  { name: "blog-mdx-poc", jiraId: null, labels: ["blog"] },
  { name: "vendor-portal-refresh", jiraId: "PROJ-9001", labels: ["webapp", "vendor"] },
];

// Empty query: passthrough, original order preserved.
assert.deepEqual(filterWorkspaces(all, ""), all, "empty query returns all, unchanged order");
assert.deepEqual(filterWorkspaces(all, "   "), all, "whitespace-only query returns all");

// Substring match on a partial word.
assert.deepEqual(
  filterWorkspaces(all, "pagev").map((w) => w.name),
  ["proj-2165-pageview-500-fix"],
  "substring match on workspace name",
);

// Labels field is searchable.
assert.deepEqual(
  filterWorkspaces(all, "webapp").map((w) => w.name),
  ["proj-2165-pageview-500-fix", "vendor-portal-refresh"],
  "labels field matches, order preserved from `all`",
);

// Multi-term query combines with AND, not OR.
assert.deepEqual(
  filterWorkspaces(all, "webapp vendor").map((w) => w.name),
  ["vendor-portal-refresh"],
  "multi-token query requires every token to match (AND)",
);

// jiraId is still searchable (existing field).
assert.deepEqual(
  filterWorkspaces(all, "proj-9001").map((w) => w.name),
  ["vendor-portal-refresh"],
  "jiraId substring match",
);

// No match -> empty result, not a throw.
assert.deepEqual(filterWorkspaces(all, "nonexistentxyz"), []);

// `-term` excludes.
assert.deepEqual(
  filterWorkspaces(all, "webapp -vendor").map((w) => w.name),
  ["proj-2165-pageview-500-fix"],
  "-term excludes matches for that term",
);

// `a|b` is an OR of alternatives.
assert.deepEqual(
  filterWorkspaces(all, "blog|vendor").map((w) => w.name),
  ["blog-mdx-poc", "vendor-portal-refresh"],
  "a|b matches either alternative",
);

// -/| combine: required term AND excluded term AND an OR group.
assert.deepEqual(
  filterWorkspaces(all, "webapp -urgent vendor|refresh").map((w) => w.name),
  ["vendor-portal-refresh"],
  "-exclude and a|b OR-group combine with the rest via AND",
);

console.log("workspace-search smoke: PASS (substring, AND-combine, exclude, OR-group, labels, empty passthrough, order)");
process.exit(0);
