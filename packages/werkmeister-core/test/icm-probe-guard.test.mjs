// SW-1103: the with-temp-home load-time guard is for one-off probes, never a repo test file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServices } from "../dist/config.js";
import { buildSandboxContextMd } from "../dist/harness/claude/claude_md.js";
import { templateFor } from "../dist/strategies/icm_templates.js";
import { withSandboxHome } from "./fixtures.mjs";

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

const PROBES_ONLY =
  /That guard is for a one-off probe run directly through `with-temp-home`, never for a test file in the repo/;

test("every ICM stage with the probe rule says the guard is for probes only", () => {
  for (const [wt, name] of [
    ["feature", "implement"],
    ["refactor", "implement"],
    ["bugfix", "reproduce"],
    ["bugfix", "exercise"],
  ])
    assert.match(steps(wt, name), PROBES_ONLY, `${wt}/${name}`);
});

test("werkmeister-context.md's probe form says it too", async () => {
  await withSandboxHome(async () => {
    const out = buildSandboxContextMd(
      "test",
      1,
      11100,
      11119,
      ["frontend"],
      loadServices(),
      "",
      {},
      ["frontend"],
      false,
      "/ws/.werkmeister/bin/with-temp-home",
    );
    assert.match(out, PROBES_ONLY);
  });
});
