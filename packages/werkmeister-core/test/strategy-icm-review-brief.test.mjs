// SW-1188: every stage that briefs a review subagent tells it never to read, list or write the real
// ~/.werkmeister, not only never to write it (sw-1158's reviewer read the real metrics log).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const LINE =
  'Also add: "never read, list or write the real `~/.werkmeister`, the host daemon or another workspace; anything you need from them, ask for or reproduce under a temp HOME"';

for (const workType of ["feature", "bugfix", "incident", "refactor"]) {
  test(`${workType}: the review brief forbids reading the real ~/.werkmeister (SW-1188)`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-review-brief-"));
    const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-review-brief-standards-"));
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
      const reviews = fs
        .readdirSync(path.join(root, "stages"))
        .map((d) => fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8"))
        .filter((c) => c.includes("`ponytail:ponytail-review`"));
      assert.ok(reviews.length > 0, `${workType} has a review stage`);
      for (const c of reviews) assert.ok(c.includes(LINE), workType);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(standardsDir, { recursive: true, force: true });
    }
  });
}
