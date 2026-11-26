// SW-1026: rule 3 said the PR-file checks stop the gate before any test, so build stages
// read `pr gate --tests` as unreachable; `--tests` skips those checks (SW-316).

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrRulesMd } from "../dist/pr_rules.js";

test("rule 3 says `pr gate --tests` skips the PR-file checks and runs before a PR file exists", () => {
  for (const autonomous of [false, true]) {
    const rule3 = buildPrRulesMd(".werkmeister/notes", autonomous)
      .split("\n")
      .find((l) => l.startsWith("3. **Gate.**"));
    assert.ok(rule3, "rule 3");
    assert.match(
      rule3,
      /the gate stops before any test command\. `pr gate --tests` skips those checks and the release check \(it needs no PR file\), so it reaches its lint and test rows in a build stage, before the PR file exists\./,
    );
  }
});
