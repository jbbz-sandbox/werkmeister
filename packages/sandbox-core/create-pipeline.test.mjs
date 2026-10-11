import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFakeGh, withSandboxHome } from "./fixtures.mjs";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { createWorkspace, prepareCreate } from "./dist/sandbox.js";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = { title: "Stale config", state: "OPEN", body: "Body.", url: "https://github.com/o/r/issues/5", labels: [], assignees: [], comments: [] };
const ANSWER = '<result>{"description":"Distilled.","starting_prompt":"## Goal\\n\\nFix."}</result>';
const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
const quiet = (fn) => withReporter(collectingReporter(), fn);

test("an issue fills task from the title and distils only empty fields", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const { resolved, issue } = await quiet(() =>
        prepareCreate({ feature: "f", issue_id: "o/r#5", description: "Mine." }, { cwd: cwd(), distill: async () => ANSWER }));
      assert.equal(issue.title, "Stale config");
      assert.equal(resolved.task, "Stale config");
      assert.equal(resolved.description, "Mine.");
      assert.equal(resolved.starting_prompt, "## Goal\n\nFix.");
    });
  }, { config: GH });
});

test("URL ref is normalised", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const { resolved } = await quiet(() =>
        prepareCreate({ feature: "f", issue_id: "https://github.com/o/r/issues/5" }, { cwd: cwd(), distill: false }));
      assert.equal(resolved.issue_id, "o/r#5");
    });
  }, { config: GH });
});

test("a failed distill still prepares, with a warning", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const rep = collectingReporter();
      const { resolved, issue } = await withReporter(rep, () =>
        prepareCreate({ feature: "f", issue_id: "o/r#5" }, { cwd: cwd(), distill: async () => null }));
      assert.ok(issue);
      assert.equal(resolved.starting_prompt, undefined);
      assert.match(rep.text(), /not filled from the issue/);
    });
  }, { config: GH });
});

test("distill: false never calls a model", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const { resolved } = await quiet(() => prepareCreate({ feature: "f", issue_id: "o/r#5" }, { cwd: cwd(), distill: false }));
      assert.equal(resolved.description, undefined);
    });
  }, { config: GH });
});

test("a fetch failure creates nothing", async () => {
  await withSandboxHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot-"));
    const prev = process.env.SANDBOX_WORKSPACES_ROOT;
    process.env.SANDBOX_WORKSPACES_ROOT = root;
    try {
      await withFakeGh({ issue: null }, async () => {
        await assert.rejects(createWorkspace({ feature: "f", issue_id: "o/r#5" }, { open: false, cwd: cwd(), distill: false }), /couldn't read o\/r#5/);
      });
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      if (prev === undefined) delete process.env.SANDBOX_WORKSPACES_ROOT;
      else process.env.SANDBOX_WORKSPACES_ROOT = prev;
    }
  }, { config: GH });
});

test("an unparseable ref fails with the tracker's example", async () => {
  await withSandboxHome(async () => {
    await assert.rejects(quiet(() => prepareCreate({ feature: "f", issue_id: "nonsense" }, { cwd: cwd(), distill: false })),
      /isn't a GitHub issue ref \(e\.g\. owner\/repo#12\)/);
  }, { config: GH });
});
