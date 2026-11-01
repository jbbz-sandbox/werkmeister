import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { buildWorkspaceArgs, createWorkspace, prepareCreate } from "./dist/sandbox.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = {
  title: "Stale config",
  state: "OPEN",
  body: "Body.",
  url: "https://github.com/o/r/issues/5",
  labels: [],
  assignees: [],
  comments: [],
};
const ANSWER =
  '<result>{"description":"Distilled.","starting_prompt":"## Goal\\n\\nFix."}</result>';
const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
const quiet = (fn) => withReporter(collectingReporter(), fn);

test("an issue fills task from the title and distils only empty fields", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        const { resolved, issue } = await quiet(() =>
          prepareCreate(
            { feature: "f", issue_id: "o/r#5", description: "Mine." },
            { cwd: cwd(), distill: async () => ANSWER },
          ),
        );
        assert.equal(issue.title, "Stale config");
        assert.equal(resolved.task, "Stale config");
        assert.equal(resolved.description, "Mine.");
        assert.equal(resolved.starting_prompt, "## Goal\n\nFix.");
      });
    },
    { config: GH },
  );
});

test("a distilled starting_prompt never lists a machine-writing step (SW-296)", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        const answer =
          '<result>{"starting_prompt":"## Where to start\\n\\n- After editing, run `werkmeister registry sync` so the registry picks it up."}</result>';
        const { resolved } = await quiet(() =>
          prepareCreate({ issue_id: "o/r#5" }, { cwd: cwd(), distill: async () => answer }),
        );
        assert.doesNotMatch(resolved.starting_prompt, /run `werkmeister registry sync`/);
        assert.match(
          resolved.starting_prompt,
          /## After merge[\s\S]*the next `werkmeister registry sync` after merge/,
        );
      });
    },
    { config: GH },
  );
});

test("an unattended create takes only description and starting_prompt from the model", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        const answer =
          '<result>{"feature":"model-pick","task":"Model task","services":["backend"],"description":"Distilled.","starting_prompt":"Go."}</result>';
        const { resolved } = await quiet(() =>
          prepareCreate({ issue_id: "o/r#5" }, { cwd: cwd(), distill: async () => answer }),
        );
        assert.equal(resolved.feature, undefined);
        assert.equal(resolved.services, undefined);
        assert.equal(resolved.task, "Stale config");
        assert.equal(resolved.description, "Distilled.");
        assert.equal(resolved.starting_prompt, "Go.");
      });
    },
    { config: GH },
  );
});

test("the extractor asks for a service whose container the issue measures (SW-280)", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        let seen = "";
        await quiet(() =>
          prepareCreate(
            { issue_id: "o/r#5" },
            {
              cwd: cwd(),
              distill: async (p) => {
                seen = p;
                return ANSWER;
              },
            },
          ),
        );
        assert.match(seen, /"services": array of the services the issue says to run locally/);
        assert.match(seen, /whose container it measures or exercises/);
        assert.match(seen, /name that service here and say to measure in its container/);
      });
    },
    { config: GH },
  );
});

test("a workspace container's own env does not leak into an unattended create (#148)", async () => {
  const keys = ["FEATURE", "SANDBOX_FEATURE", "WERKMEISTER_SLOT"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    FEATURE: "repo-dir-drift",
    SANDBOX_FEATURE: "repo-dir-drift",
    WERKMEISTER_SLOT: "3",
  });
  try {
    await withSandboxHome(
      async () => {
        await withFakeGh({ issue: ISSUE }, async () => {
          const { resolved } = await quiet(() =>
            prepareCreate({ issue_id: "o/r#5" }, { cwd: cwd(), distill: false }),
          );
          assert.equal(resolved.feature, undefined);
        });
      },
      { config: GH },
    );
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test("URL ref is normalised", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        const { resolved } = await quiet(() =>
          prepareCreate(
            { feature: "f", issue_id: "https://github.com/o/r/issues/5" },
            { cwd: cwd(), distill: false },
          ),
        );
        assert.equal(resolved.issue_id, "o/r#5");
      });
    },
    { config: GH },
  );
});

test("a failed distill still prepares, with a warning", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        const rep = collectingReporter();
        const { resolved, issue } = await withReporter(rep, () =>
          prepareCreate(
            { feature: "f", issue_id: "o/r#5" },
            { cwd: cwd(), distill: async () => null },
          ),
        );
        assert.ok(issue);
        assert.equal(resolved.starting_prompt, undefined);
        assert.match(rep.text(), /not filled from the issue/);
      });
    },
    { config: GH },
  );
});

test("distill: false never calls a model", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({ issue: ISSUE }, async () => {
        const { resolved } = await quiet(() =>
          prepareCreate({ feature: "f", issue_id: "o/r#5" }, { cwd: cwd(), distill: false }),
        );
        assert.equal(resolved.description, undefined);
      });
    },
    { config: GH },
  );
});

test("a fetch failure creates nothing", async () => {
  await withSandboxHome(
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsroot-"));
      const prev = process.env.WERKMEISTER_WORKSPACES_ROOT;
      process.env.WERKMEISTER_WORKSPACES_ROOT = root;
      try {
        await withFakeGh({ issue: null }, async () => {
          await assert.rejects(
            createWorkspace(
              { feature: "f", issue_id: "o/r#5" },
              { open: false, cwd: cwd(), distill: false },
            ),
            /couldn't read o\/r#5/,
          );
        });
        assert.deepEqual(fs.readdirSync(root), []);
      } finally {
        if (prev === undefined) delete process.env.WERKMEISTER_WORKSPACES_ROOT;
        else process.env.WERKMEISTER_WORKSPACES_ROOT = prev;
      }
    },
    { config: GH },
  );
});

test("an unparseable ref fails with the tracker's example", async () => {
  await withSandboxHome(
    async () => {
      await assert.rejects(
        quiet(() =>
          prepareCreate({ feature: "f", issue_id: "nonsense" }, { cwd: cwd(), distill: false }),
        ),
        /isn't a GitHub issue ref \(e\.g\. owner\/repo#12\)/,
      );
    },
    { config: GH },
  );
});

test("a missing feature tells the CLI user how to give one", () => {
  assert.throws(
    () => buildWorkspaceArgs({}),
    /^WorkspaceError: A feature name is required \(pass it as an argument, set it in \.\/\.werkmeister\/workspace\.yml, or run interactively\)\.$/,
  );
});
