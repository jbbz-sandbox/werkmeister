// SW-1205: no interactive base, ICM stage or autonomous allow rule reaches the host daemon or shared infra.
// The other permission tests assert only the rules each is about, so a widening there passed them all.

import assert from "node:assert/strict";
import { test } from "node:test";

import { cli } from "../dist/harness/autonomous_deny.js";
import { autonomousRules, buildAllowRules } from "../dist/harness/claude/hooks_gen.js";
import { ICM_TEMPLATES, stageGrants } from "../dist/strategies/icm_templates.js";

// Claude Code's matching: `:*` is a word-boundary prefix, any other rule exact (SW-560's probe).
const claudeAllows = (rules, cmd) =>
  rules.some((r) => {
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
    return m && (m[2] ? cmd === m[1] || cmd.startsWith(`${m[1]} `) : cmd === m[1]);
  });

const REACHES_OUT = [
  "daemon restart",
  "daemon install",
  "infra up",
  "infra restart",
  "infra down",
  "machine setup",
  "machine clean",
  "feature down",
  "workspace new",
  "feature stop infra",
];

test("SW-1205: no base, ICM or autonomous allow rule reaches the daemon or shared infra", () => {
  const sets = {
    base: buildAllowRules("", [], {}, {}),
    autonomous: autonomousRules("feat", ["api"]),
    ...Object.fromEntries(
      Object.keys(ICM_TEMPLATES).map((wt) => [`icm ${wt}`, stageGrants(wt).flatMap(cli)]),
    ),
  };
  for (const [label, rules] of Object.entries(sets))
    for (const name of ["werkmeister", "w9r"])
      for (const cmd of REACHES_OUT)
        for (const call of [`${name} ${cmd}`, `${name} ${cmd} x`])
          assert.ok(!claudeAllows(rules, call), `${label}: ${call}`);
});
