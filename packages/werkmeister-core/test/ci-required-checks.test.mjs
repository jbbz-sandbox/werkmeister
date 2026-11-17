// SW-847: the merge queue refuses a PR until every required check reports by name.
// A matrix job skipped at job level never expands, so it reports its bare name and
// none of its legs, and the Changesets version PR could not queue.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

// shortcut: copied from the `main` ruleset (id 25701432); read it live if it starts drifting.
const REQUIRED = ["test", "core-test (1)", "core-test (2)", "node-floor"];
const CI = new URL("../../../.github/workflows/ci.yml", import.meta.url);

/** The check names `ci.yml` reports on a pull_request from `headRef`. */
function reportedChecks(yamlText, headRef) {
  const names = [];
  for (const [key, job] of Object.entries(parse(yamlText).jobs)) {
    const name = job.name ?? key;
    // Only the version-PR skip is modelled: other job-level conditions hold on a PR.
    const skipped =
      typeof job.if === "string" && job.if.includes(`github.head_ref != '${headRef}'`);
    const matrix = job.strategy?.matrix;
    if (skipped || !matrix) {
      names.push(name);
      continue;
    }
    const axes = Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude");
    let combos = [[]];
    for (const [, values] of axes) combos = combos.flatMap((c) => values.map((v) => [...c, v]));
    for (const c of combos) names.push(`${name} (${c.join(", ")})`);
  }
  return names;
}

const missing = (yamlText, headRef) => {
  const reported = reportedChecks(yamlText, headRef);
  return REQUIRED.filter((n) => !reported.includes(n));
};

test("the version PR reports every required check by name", () => {
  assert.deepEqual(missing(readFileSync(CI, "utf8"), "changeset-release/main"), []);
});

test("a normal PR reports every required check by name", () => {
  assert.deepEqual(missing(readFileSync(CI, "utf8"), "jayboyer/some-feature"), []);
});

test("a matrix job skipped at job level loses its legs", () => {
  const yml = `jobs:
  test: {if: "github.head_ref != 'changeset-release/main'"}
  node-floor: {}
  core-test:
    if: "github.head_ref != 'changeset-release/main'"
    strategy: {matrix: {shard: [1, 2]}}
`;
  assert.deepEqual(missing(yml, "changeset-release/main"), ["core-test (1)", "core-test (2)"]);
});

test("a renamed matrix leg is caught", () => {
  const yml = `jobs:
  test: {}
  node-floor: {}
  core-test: {strategy: {matrix: {part: [a, b]}}}
`;
  assert.deepEqual(missing(yml, "jayboyer/x"), ["core-test (1)", "core-test (2)"]);
});
