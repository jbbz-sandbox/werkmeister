// SW-1157: every human check tells the agent to grep the stage outputs for `status: proposed`
// and ask every hit before the turn ends, re-asking an interrupted question call.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { askLine } from "../dist/strategies/icm_templates.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const LINE =
  ' Before ending the turn, `grep -l "status: proposed" stages/*/output/*.md` and ask every hit. If the question call errors or is interrupted, ask it again.';

test("both ask variants end with the ask-every-hit line (SW-1157)", () => {
  assert.ok(askLine("AskUserQuestion").endsWith(LINE));
  assert.ok(askLine().endsWith(LINE));
});

test("every stage contract's human check has it (SW-1157)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-ask-all-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-ask-all-standards-"));
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
            inputs: { work_type: "feature", starting_prompt: "p", autonomous: "false" },
            configOverride: null,
          }),
        ),
      { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
    );
    const dirs = fs.readdirSync(path.join(root, "stages")).sort();
    assert.equal(dirs.length, 4);
    for (const d of dirs) {
      const c = fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8");
      const check = c.slice(c.indexOf("## Human check"));
      assert.ok(check.includes(LINE.trim()), d);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
});
