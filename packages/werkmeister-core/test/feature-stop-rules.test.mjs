// SW-1215: an autonomous workspace pre-approves stopping its own feature, exactly, and nothing broader.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "../dist/config.js";
import { autonomousRules, workspaceAllowRules } from "../dist/harness/claude/hooks_gen.js";
import { withSandboxHome } from "./fixtures.mjs";

// Claude Code's matching: `:*` is a word-boundary prefix, any other rule exact (SW-560's probe).
const claudeAllows = (rules, cmd) =>
  rules.some((r) => {
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
    return m && (m[2] ? cmd === m[1] || cmd.startsWith(`${m[1]} `) : cmd === m[1]);
  });

function check(label, rules) {
  for (const name of ["werkmeister", "w9r"]) {
    for (const cmd of ["feature stop", "feature stop feat", "stop", "stop feat"])
      assert.ok(claudeAllows(rules, `${name} ${cmd}`), `${label}: ${name} ${cmd}`);
    for (const cmd of [
      "feature stop infra",
      "feature stop other",
      "stop infra",
      "stop other",
      "feature stop feat other",
      "feature stop feat --via-daemon",
      "feature stop --idle 30",
      "stop --if-idle --via-daemon",
    ])
      assert.ok(!claudeAllows(rules, `${name} ${cmd}`), `${label}: ${name} ${cmd}`);
  }
  assert.deepEqual(
    rules.filter((r) => / stop[^)]*:\*\)$/.test(r)),
    [],
    `${label}: no stop prefix rule`,
  );
}

test("SW-1215: an autonomous workspace stops only its own feature, host-mounted services or not", async () => {
  check("autonomousRules", autonomousRules("feat", ["api"]));
  // SW-854 drops whole-feature starts for a host-mounted service; a stop runs no `command:`, so it stays.
  check("host-mounted", autonomousRules("feat", ["api"], [], ["api"]));
  await withSandboxHome(async (home) => {
    const root = fs.mkdtempSync(path.join(home, "ws-stop-"));
    fs.mkdirSync(dotDir(root), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api\n");
    check("workspaceAllowRules", workspaceAllowRules(root, true));
    assert.ok(
      !claudeAllows(workspaceAllowRules(root, false), "werkmeister feature stop"),
      "interactive asks",
    );
  });
});
