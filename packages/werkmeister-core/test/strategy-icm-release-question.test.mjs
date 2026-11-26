// SW-1210: a changesets repo's release-entry question never offers "none"; the release check refuses it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { stageDirs, templateFor } from "../dist/strategies/icm_templates.js";
import { strategyById } from "../dist/strategies/index.js";
import { withSandboxHome } from "./fixtures.mjs";

const OPTIONS =
  "a question on whether the change needs a release entry offers two answers, an empty changeset (`changeset add --empty`: no release) or a patch or minor entry, never none";

test("every work type's first stage offers an empty changeset or an entry, never none", async () => {
  for (const wt of ["feature", "bugfix", "refactor", "spike"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `icm-release-${wt}-`));
    const std = fs.mkdtempSync(path.join(os.tmpdir(), `icm-release-${wt}-standards-`));
    try {
      await withSandboxHome(
        () =>
          strategyById("icm").init({
            workspaceRoot: root,
            workspaceName: "demo",
            repos: [["repo", "me/demo"]],
            task: "t",
            meta: { FEATURE: "demo", SERVICES: "api" },
            inputs: { work_type: wt, starting_prompt: "p", autonomous: "false" },
            configOverride: null,
          }),
        { config: `overrides:\n  standards_dir: ${std}\n` },
      );
      const first = stageDirs(templateFor(wt))[0];
      const c = fs.readFileSync(path.join(root, "stages", first, "CONTEXT.md"), "utf8");
      assert.ok(c.includes(OPTIONS), `${wt}/${first}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(std, { recursive: true, force: true });
    }
  }
});
