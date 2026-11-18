import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { buildWorkspaceArgs, createWorkspace, prepareCreate } from "../dist/sandbox.js";
import { resolveInputs } from "../dist/workspace_prompts.js";
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

test("an unattended create takes services the issue names verbatim, in its repos (SW-342)", async () => {
  await withSandboxHome(
    async () => {
      const body = "Service: {{frontend}}. Not apps/backend or backend-old.";
      await withFakeGh({ issue: { ...ISSUE, body } }, async () => {
        const { resolved } = await quiet(() =>
          prepareCreate({ issue_id: "o/r#5", repos: "demo-repo" }, { cwd: cwd(), distill: false }),
        );
        assert.equal(resolved.services, "frontend");
        const other = await quiet(() =>
          prepareCreate({ issue_id: "o/r#5", repos: "other" }, { cwd: cwd(), distill: false }),
        );
        assert.equal(other.resolved.services, undefined, "a service outside the chosen repos");
        const mine = await quiet(() =>
          prepareCreate(
            { issue_id: "o/r#5", repos: "demo-repo", services: "backend" },
            { cwd: cwd(), distill: false },
          ),
        );
        assert.equal(mine.resolved.services, "backend", "a chosen services list is kept");
      });
    },
    { config: GH },
  );
});

test("a blank services value is not overridden by the issue match; an info line names matched ones (SW-413)", async () => {
  await withSandboxHome(
    async () => {
      const body = "Service: {{frontend}}.";
      await withFakeGh({ issue: { ...ISSUE, body } }, async () => {
        const run = async (extra) => {
          const reporter = collectingReporter();
          const { resolved } = await withReporter(reporter, () =>
            prepareCreate(
              { issue_id: "o/r#5", repos: "demo-repo", ...extra },
              { cwd: cwd(), distill: false },
            ),
          );
          return { resolved, out: reporter.text() };
        };
        for (const blank of [{ services: "" }, { services: "  " }, { services: [] }]) {
          const r = await run(blank);
          assert.ok(!r.resolved.services, JSON.stringify(blank));
          assert.doesNotMatch(r.out, /taken from the issue/);
        }
        // The CLI resolves first and hands prepareCreate the resolved object (`workspace.ts` run()).
        const viaCli = await run(resolveInputs({ services: "" }, cwd()));
        assert.ok(!viaCli.resolved.services, "a blank --services survives resolveInputs");
        const absent = await run({});
        assert.equal(absent.resolved.services, "frontend");
        assert.match(absent.out, /Services taken from the issue text: frontend/);
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

test("a service named only in a quoted command is not taken; the brief's service or a named code path is (SW-707)", async () => {
  const services = `services:
  docs-site:
    type: web
    repo: demo-repo
    path: apps/docs-site
    port_offset: 2
  werkmeister-core:
    type: api
    repo: demo-repo
    path: packages/werkmeister-core
    port_offset: 3
`;
  // SW-614's body: the evidence command names docs-site; nothing else names a service.
  const quoted =
    "On 2026-11-08 {{werkmeister feature up \\-\\-service docs\\-site}} printed:\n\n" +
    "    [warn] werkmeister daemon not reachable (ECONNRESET).\n";
  const create = (body, distill) =>
    withFakeGh({ issue: { ...ISSUE, body } }, () =>
      quiet(() =>
        prepareCreate({ issue_id: "o/r#5", repos: "demo-repo" }, { cwd: cwd(), distill }),
      ),
    );
  await withSandboxHome(
    async () => {
      const bare = await create(quoted, false);
      assert.equal(bare.resolved.services, undefined, "a --service inside a quoted command");
      const block = await create(
        "{noformat}\nwerkmeister-core: ok\n{noformat}\n```\ndocs-site\n```",
        false,
      );
      assert.equal(block.resolved.services, undefined, "ids only inside log blocks");
      const byPath = await create(
        `${quoted}\nThe client is in {{packages/werkmeister\\-core/src}}.`,
        false,
      );
      assert.equal(byPath.resolved.services, "werkmeister-core", "a code path the issue names");
      const between = await create("Fix `a b` in werkmeister-core, see `c d` too.", false);
      assert.equal(between.resolved.services, "werkmeister-core", "prose between two code spans");
      const nested = await create(
        "- a\n    - change werkmeister-core here\n\t* or docs-site",
        false,
      );
      assert.equal(
        nested.resolved.services,
        "docs-site,werkmeister-core",
        "nested list items (SW-886)",
      );
      const brief =
        '<result>{"description":"D.","starting_prompt":"## Where to start\\n- Repo werkmeister, service werkmeister-core."}</result>';
      const byBrief = await create(quoted, async () => brief);
      assert.equal(byBrief.resolved.services, "werkmeister-core", "the brief's named service");
    },
    { config: GH, services },
  );
});
