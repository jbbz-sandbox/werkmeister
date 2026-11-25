// SW-1160: the bugfix reproduce stage lists callers of a shared writer that write other
// workspaces' or the machine's files; other work types' first stage does not say it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const RULE =
  /When the fix changes a shared writer or adds persisted state, list each caller that writes another workspace's files or the machine's \(a migrate or sweep across workspaces, a daemon, close-out\), and settle how the change reaches each before the fix is decided; give each such caller a test that the new state is or isn't written there\./;

async function firstStage(workType) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-writer-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-writer-standards-"));
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
            inputs: { work_type: workType, starting_prompt: "p", autonomous: "false" },
            configOverride: null,
          }),
        ),
      { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
    );
    const first = fs.readdirSync(path.join(root, "stages")).sort()[0];
    return fs.readFileSync(path.join(root, "stages", first, "CONTEXT.md"), "utf8");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
}

test("bugfix 01_reproduce names cross-workspace and machine writers of a shared writer (SW-1160)", async () => {
  assert.match(await firstStage("bugfix"), RULE);
  assert.doesNotMatch(await firstStage("feature"), RULE);
});
