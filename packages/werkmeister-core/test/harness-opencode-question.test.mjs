// SW-550: an OpenCode ICM workspace's human checks ask through OpenCode's `question` tool,
// which a real OpenCode 2.2.5 turn lists (stage 01 decision D3), never Claude's AskUserQuestion.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { harnessLayoutFor } from "../dist/harness/layout.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("icm init on opencode: every stage's Human check names the `question` tool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-question-"));
  try {
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(
      path.join(root, ".werkmeister", "workspace.yml"),
      "task: Question tool\nwork_type: feature\ncontext_strategy: icm\nharness: opencode\n",
    );
    await withSandboxHome(() => withReporter(collectingReporter(), () => initWorkspace({}, root)));

    assert.equal(harnessLayoutFor(root).questionTool, "question");
    const stages = fs.readdirSync(path.join(root, "stages"));
    assert.ok(stages.length > 0, "no stages written");
    for (const stage of stages) {
      const text = fs.readFileSync(path.join(root, "stages", stage, "CONTEXT.md"), "utf8");
      const check = text.slice(text.indexOf("## Human check"));
      assert.match(check, /Ask this check through `question`:/, stage);
      assert.doesNotMatch(text, /AskUserQuestion/, stage);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
