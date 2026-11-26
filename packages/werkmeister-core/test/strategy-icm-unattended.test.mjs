// SW-1208: the stages that settle a design ask whether a widened path runs with no person present,
// and give it the unattended deny floor; the fix and implement stages' allowlist check stays as it was.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const LINE =
  "A blocklist needs a stated reason. Does the widened path run with no person present (headless, unattended, a relay or callback)? If so, it gets the unattended deny floor (the deny list an autonomous run gets) unless the design says why not.";

for (const workType of ["feature", "bugfix", "incident"]) {
  test(`${workType}: the design stage asks about a path with no person present (SW-1208)`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-unattended-"));
    const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-unattended-standards-"));
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
      for (const d of fs.readdirSync(path.join(root, "stages"))) {
        const c = fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8");
        if (/_(research|reproduce)$/.test(d)) assert.ok(c.includes(LINE), `${workType}/${d}`);
        else assert.ok(!c.includes("no person present"), `${workType}/${d}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(standardsDir, { recursive: true, force: true });
    }
  });
}
