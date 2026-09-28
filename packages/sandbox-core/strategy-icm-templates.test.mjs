// Every work type the wizard offers (WORK_TYPE_PHASES) has an icm template,
// and each renders without holes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { strategyById } from "./dist/strategies/index.js";
import { ICM_TEMPLATES, templateFor } from "./dist/strategies/icm_templates.js";
import { WORK_TYPE_PHASES } from "./dist/workspace_prompts.js";

const EXPECTED = {
  feature: ["research", "spec", "implement", "ship"],
  bugfix: ["reproduce", "fix", "verify", "ship"],
  incident: ["reproduce", "fix", "verify", "ship"],
  refactor: ["scope", "implement", "ship"],
  spike: ["questions", "findings"],
};

test("every wizard work type has its template", () => {
  for (const wt of Object.keys(WORK_TYPE_PHASES)) {
    assert.ok(Object.hasOwn(ICM_TEMPLATES, wt), `no icm template for ${wt}`);
    assert.deepEqual(templateFor(wt).map((s) => s.name), EXPECTED[wt], wt);
  }
});

// Task 3's trim/lowercase normalisation was only pinned by `feature` while it
// was the only template. Now that `bugfix` exists too, this fails if the
// normalisation is ever dropped.
test("templateFor normalises free-text casing and whitespace", () => {
  assert.deepEqual(templateFor(" Bugfix ").map((s) => s.name), EXPECTED["bugfix"]);
});

test("each template renders with no undefined and a route per stage", async () => {
  for (const wt of Object.keys(EXPECTED)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${wt}-`));
    // Empty standards tree in a temp dir: without this override, withSandboxHome
    // would fall through to the developer's real standards_dir and read their
    // actual standards tree instead of a hermetic empty one.
    const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${wt}-standards-`));
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
              inputs: { work_type: wt, starting_prompt: "p" },
              hasServiceMap: false,
              configOverride: null,
            }),
          ),
        { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
      );
      const dirs = fs.readdirSync(path.join(root, "stages")).sort();
      assert.deepEqual(dirs, EXPECTED[wt].map((n, i) => `0${i + 1}_${n}`), wt);
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      assert.ok(claude.split("\n").length <= 60, `${wt}: CLAUDE.md over 60 lines`);
      for (const d of dirs) {
        assert.match(claude, new RegExp(`stages/${d}/CONTEXT\\.md`), `${wt}: no route to ${d}`);
        const c = fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8");
        assert.doesNotMatch(c, /undefined/, `${wt}/${d}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(standardsDir, { recursive: true, force: true });
    }
  }
});
