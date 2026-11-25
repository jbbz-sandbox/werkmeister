// SW-1139: a grouped workspace's commit stages say to keep per-ticket tests in their own files and
// tickets off adjacent lines, and name the gate's revert-alone row; a single-ticket one is unchanged.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const RULE =
  /Put each ticket's new tests in a test file of its own, not one another ticket's tests also go in, and keep one ticket's edits off lines next to another ticket's where you can: `werkmeister pr gate --tests` reverts each commit alone in a throwaway worktree and fails naming the one that conflicts\./;

async function contracts(workType, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-layout-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-layout-standards-"));
  try {
    await withSandboxHome(
      () =>
        withReporter(collectingReporter(), async () =>
          strategyById("icm").init({
            workspaceRoot: root,
            workspaceName: "demo",
            repos: [["repo", "me/demo"]],
            task: "t",
            meta: { FEATURE: "demo", SERVICES: "api" },
            inputs: { work_type: workType, starting_prompt: "p", autonomous: "false", ...extra },
            configOverride: null,
          }),
        ),
      { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
    );
    const dirs = fs.readdirSync(path.join(root, "stages")).sort();
    return Object.fromEntries(
      dirs.map((d) => [d, fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8")]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
}

const COMMIT_STAGES = { bugfix: "02_fix", feature: "03_implement", refactor: "02_implement" };

test("grouped: every commit stage has the per-ticket test file and adjacent-lines rule (SW-1139)", async () => {
  for (const [wt, stage] of Object.entries(COMMIT_STAGES)) {
    const on = await contracts(wt, { group: "SW-2" });
    assert.match(on[stage], RULE, `${wt} ${stage}`);
    // Only the stage that commits: the plan stages leave commits to it.
    for (const [d, c] of Object.entries(on)) if (d !== stage) assert.doesNotMatch(c, RULE, d);
  }
});

test("single-ticket: no stage has the rule (SW-1139)", async () => {
  for (const wt of Object.keys(COMMIT_STAGES)) {
    for (const [d, c] of Object.entries(await contracts(wt, {})))
      assert.doesNotMatch(c, /reverts each commit alone|test file of its own/, `${wt} ${d}`);
  }
});
