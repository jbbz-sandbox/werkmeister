// SW-1021: a background test, gate or `pr open` run names its log and a `! tail -f` line at once, and the record commit stages every gate log.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrRulesMd } from "../dist/pr_rules.js";
import { templateFor } from "../dist/strategies/icm_templates.js";

const vars = {
  at: (n) => `../${n}`,
  repos: "`../../repo/`",
  restart: "r",
  standards: "",
  autonomous: false,
  group: [],
};
const steps = (wt, name) =>
  templateFor(wt)
    .find((s) => s.name === name)
    .contract(vars)
    .process.join("\n");

const TAIL =
  /give the person the log's absolute path and a `! tail -f <absolute log path>` line to follow it; never run `tail -f` from your own Bash: it never returns/;
const LOGS =
  /Each record commit after a gate run stages the gate's logs by name, `git -C <absolute workspace path> add '\.werkmeister\/logs\/gate-\*\.log'`.*never `git commit -a`/;

test("pr-rules rule 3 names the log, the tail -f line and the gate logs in the record commit", () => {
  const rule3 = buildPrRulesMd("stages/04_propose/output/")
    .split("\n")
    .find((l) => l.startsWith("3. **Gate.**"));
  assert.match(rule3, TAIL);
  assert.match(rule3, LOGS);
});

test("every ICM test step says the same", () => {
  for (const [wt, name] of [
    ["feature", "implement"],
    ["refactor", "implement"],
    ["bugfix", "fix"],
  ]) {
    const c = steps(wt, name);
    assert.match(c, TAIL, `${wt}/${name}`);
    assert.match(c, LOGS, `${wt}/${name}`);
  }
});
