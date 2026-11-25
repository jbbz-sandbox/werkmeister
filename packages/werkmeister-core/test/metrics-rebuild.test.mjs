// SW-780: `werkmeister metrics rebuild` backfills the event log from two record branches, a fake
// gh and a transcript; a second run adds nothing; the shared repo's refs never change.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { sandboxHome, workspacesRoot } from "../dist/config.js";
import { writeFakes } from "../dist/fixture_fakes.js";
import { workspaceSlice } from "../dist/metrics.js";
import { rebuildMetrics } from "../dist/metrics_rebuild.js";
import { metricsReport } from "../dist/metrics_report.js";
import { withSandboxHome } from "./fixtures.mjs";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js").default;
const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../docs/superpowers/specs/2026-11-15-metrics-events.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({
  formats: { "date-time": (s) => !Number.isNaN(Date.parse(s)), uri: (s) => URL.canParse(s) },
}).compile(schema);

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

const PR = "https://github.com/o/app/pull/1";
const T1 = "2026-11-10T10:00:00.000Z";
const T2 = "2026-11-10T10:01:30.000Z";
const SID = "11111111-1111-1111-1111-111111111111";
const SID_LIVE = "22222222-2222-2222-2222-222222222222";

/** Two record branches in a bare origin, the shared checkout cloned from it, transcripts, fake gh. *runId*: ws-a's workspace.yml run_id. */
function seed({ runId } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "records-")));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@t");
  git(work, "config", "user.name", "t");
  const commit = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", rel);
    return git(work, "log", "-1", "--format=%H %cI").split(" ");
  };
  commit("README.md", "scaffold\n");
  git(work, "checkout", "-q", "-b", "me/ws-a");
  if (runId) commit(".werkmeister/workspace.yml", `run_id: ${runId}\n`);
  commit("stages/01_research/output/.gitkeep", "");
  const a1 = commit("stages/01_research/output/inventory.md", "a\n");
  commit("stages/01_research/output/decisions.md", "later file, same stage\n");
  const a4 = commit("stages/04_propose/output/pr-app.md", `---\nurl: ${PR}\n---\n# PR\n`);
  commit("usage.json", JSON.stringify({ schema: 1, workspace: "ws-a", ticket: "SW-1" }));
  git(work, "checkout", "-q", "main");
  git(work, "checkout", "-q", "-b", "me/ws-b");
  const b1 = commit("stages/01_research/output/inventory.md", "b\n");
  git(work, "checkout", "-q", "main");
  // A reused workspace name (another user's ws-b): its own stage commit is a separate stage.done.
  git(work, "checkout", "-q", "-b", "other/ws-b");
  const c1 = commit("stages/01_research/output/inventory.md", "c\n");
  git(work, "checkout", "-q", "main");
  const origin = path.join(root, "origin.git");
  git(root, "clone", "-q", "--bare", work, origin);
  fs.mkdirSync(path.join(os.homedir(), "repos"));
  const shared = path.join(os.homedir(), "repos", "sandbox-workspace");
  git(root, "clone", "-q", origin, shared);

  const projects = path.join(
    os.homedir(),
    ".claude",
    "projects",
    path.join(workspacesRoot(), "ws-a").replace(/[^a-zA-Z0-9]/g, "-"),
  );
  fs.mkdirSync(projects, { recursive: true });
  const ask = (sid, at) =>
    JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: {
        content: [{ type: "tool_use", id: `toolu_${sid.slice(0, 4)}`, name: "AskUserQuestion" }],
      },
    });
  const result = (sid, at) =>
    JSON.stringify({
      type: "user",
      timestamp: at,
      message: { content: [{ type: "tool_result", tool_use_id: `toolu_${sid.slice(0, 4)}` }] },
    });
  fs.writeFileSync(
    path.join(projects, `${SID}.jsonl`),
    [ask(SID, T1), "not json", result(SID, T2)].join("\n"),
  );
  fs.writeFileSync(
    path.join(projects, `${SID_LIVE}.jsonl`),
    [ask(SID_LIVE, T1), result(SID_LIVE, T2)].join("\n"),
  );
  // SW-776's live writer already logged this session: rebuild must leave it alone.
  fs.mkdirSync(path.join(sandboxHome(), "metrics"), { recursive: true });
  fs.writeFileSync(
    path.join(sandboxHome(), "metrics", "events-2026-11.jsonl"),
    `${JSON.stringify({ v: 1, at: T1, event: "ask", workspace: "ws-a", session: SID_LIVE, kind: "question" })}\n`,
  );

  const { gh } = writeFakes(path.join(root, "fakes"), { prState: "MERGED" });
  return { root, origin, shared, gh, a1, a4, b1, c1 };
}

function logLines() {
  const dir = path.join(sandboxHome(), "metrics");
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("events-"))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trimEnd().split("\n"))
    .map((l) => {
      const o = JSON.parse(l);
      assert.ok(validate(o), JSON.stringify(validate.errors));
      return o;
    });
}

const logBytes = () => {
  const dir = path.join(sandboxHome(), "metrics");
  return Object.fromEntries(
    fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
};

test("rebuild writes the expected lines once, and never changes the shared repo's refs", async () => {
  await withSandboxHome(
    async (home) => {
      const fx = seed();
      const prevGh = process.env.WERKMEISTER_GH_BIN;
      process.env.WERKMEISTER_GH_BIN = fx.gh;
      try {
        const refs = () => [git(fx.shared, "for-each-ref"), git(fx.origin, "for-each-ref")];
        const before = refs();

        const first = await rebuildMetrics();
        const iso = (t) => new Date(t).toISOString();
        const got = logLines()
          .filter((e) => e.session !== SID_LIVE)
          .map(({ v, ...e }) => e)
          .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
        const want = [
          {
            at: iso(fx.a1[1]),
            event: "stage.done",
            workspace: "ws-a",
            stage: "01_research",
            commit: fx.a1[0],
          },
          {
            at: iso(fx.a4[1]),
            event: "stage.done",
            workspace: "ws-a",
            stage: "04_propose",
            commit: fx.a4[0],
          },
          {
            at: iso(fx.b1[1]),
            event: "stage.done",
            workspace: "ws-b",
            stage: "01_research",
            commit: fx.b1[0],
          },
          {
            at: iso(fx.c1[1]),
            event: "stage.done",
            workspace: "ws-b",
            stage: "01_research",
            commit: fx.c1[0],
          },
          {
            at: "2026-01-02T03:04:05Z",
            event: "pr.open",
            workspace: "ws-a",
            ticket: "SW-1",
            pr: PR,
          },
          {
            at: "2026-01-02T04:05:06Z",
            event: "pr.merged",
            workspace: "ws-a",
            ticket: "SW-1",
            pr: PR,
          },
          { at: T1, event: "ask", workspace: "ws-a", session: SID, kind: "question" },
          { at: T2, event: "answer", workspace: "ws-a", session: SID, waited_s: 90 },
        ].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
        assert.deepEqual(got, want);
        assert.equal(first.total, 8);
        assert.equal(
          logLines().filter((e) => e.session === SID_LIVE).length,
          1,
          "the live session is skipped",
        );
        for (const f of fs.readdirSync(path.join(sandboxHome(), "metrics")))
          assert.ok(
            path.join(sandboxHome(), "metrics", f).startsWith(home),
            "log stays under the temp home",
          );

        const snapshot = logBytes();
        const second = await rebuildMetrics();
        assert.equal(second.total, 0);
        assert.deepEqual(logBytes(), snapshot, "a second run adds no lines");

        assert.deepEqual(refs(), before, "the shared repo and its origin keep their refs");
        assert.equal(fs.existsSync(first.clone), false, "the temporary clone is removed");
        assert.equal(fs.existsSync(second.clone), false);
      } finally {
        if (prevGh === undefined) delete process.env.WERKMEISTER_GH_BIN;
        else process.env.WERKMEISTER_GH_BIN = prevGh;
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

test("no workspace repo: rebuild throws and writes nothing", async () => {
  await withSandboxHome(async () => {
    await assert.rejects(rebuildMetrics(), /no workspace repo/);
    assert.equal(fs.existsSync(path.join(sandboxHome(), "metrics")), false);
  });
});

// SW-1025: a live stage.done already in the log is not written again by rebuild.
test("rebuild adds no stage.done for a stage the live writer already logged at that commit", async () => {
  await withSandboxHome(
    async () => {
      const fx = seed();
      const prevGh = process.env.WERKMEISTER_GH_BIN;
      process.env.WERKMEISTER_GH_BIN = fx.gh;
      try {
        fs.appendFileSync(
          path.join(sandboxHome(), "metrics", "events-2026-11.jsonl"),
          `${JSON.stringify({ v: 1, at: new Date(fx.a1[1]).toISOString(), event: "stage.done", workspace: "ws-a", stage: "01_research", commit: fx.a1[0] })}\n`,
        );
        await rebuildMetrics();
        const done = logLines().filter(
          (e) => e.event === "stage.done" && e.workspace === "ws-a" && e.stage === "01_research",
        );
        assert.equal(done.length, 1);
      } finally {
        if (prevGh === undefined) delete process.env.WERKMEISTER_GH_BIN;
        else process.env.WERKMEISTER_GH_BIN = prevGh;
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

// SW-1158: rebuilt lines carry their branch's run_id, so a same-named run's late pr.merged stays out of my slice.
test("rebuilt events carry the record branch's run_id; a same-named run's pr.merged stays out of my slice", async () => {
  await withSandboxHome(
    async () => {
      const fx = seed({ runId: "run-a" });
      const prevGh = process.env.WERKMEISTER_GH_BIN;
      process.env.WERKMEISTER_GH_BIN = fx.gh;
      try {
        await rebuildMetrics();
        const tags = (ws) =>
          logLines()
            .filter((e) => e.workspace === ws && e.event !== "ask" && e.event !== "answer")
            .map((e) => [e.event, e.run_id])
            .sort();
        assert.deepEqual(tags("ws-a"), [
          ["pr.merged", "run-a"],
          ["pr.open", "run-a"],
          ["stage.done", "run-a"],
          ["stage.done", "run-a"],
        ]);
        assert.deepEqual(
          tags("ws-b"),
          [
            ["stage.done", undefined],
            ["stage.done", undefined],
          ],
          "a branch with no run_id rebuilds untagged",
        );

        // My own ws-a run, started (2026-01-01) before the other run's pr.merged (2026-01-02).
        const mine = path.join(fx.root, "mine", "ws-a");
        git(fx.root, "clone", "-q", fx.origin, mine);
        git(mine, "checkout", "-q", "-b", "mine/ws-a");
        fs.mkdirSync(path.join(mine, ".werkmeister"));
        fs.writeFileSync(path.join(mine, ".werkmeister", "workspace.yml"), "run_id: run-mine\n");
        execFileSync(
          "git",
          ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"].concat([
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
          ]),
          {
            cwd: mine,
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
              GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
            },
          },
        );
        const events = workspaceSlice(mine).map((l) => JSON.parse(l).event);
        assert.ok(!events.includes("pr.merged"), `slice: ${events}`);
      } finally {
        if (prevGh === undefined) delete process.env.WERKMEISTER_GH_BIN;
        else process.env.WERKMEISTER_GH_BIN = prevGh;
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

// SW-1104: two people's close-outs against one workspace repo show up in one report.
test("rebuild brings in every teammate's slice and usage, and the report covers both people", async () => {
  await withSandboxHome(
    async (home) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-")));
      try {
        const line = (o) => JSON.stringify({ v: 1, ...o });
        const PR_A = "https://github.com/o/app/pull/1";
        const PR_B = "https://github.com/o/web/pull/2";
        const sliceA = [
          line({
            at: "2026-11-17T00:30:00.000Z",
            event: "issue.start",
            workspace: "ws-a",
            ticket: "SW-1",
          }),
          line({
            at: "2026-11-17T09:00:00.000Z",
            event: "pr.merged",
            workspace: "ws-a",
            ticket: "SW-1",
            pr: PR_A,
          }),
          line({
            at: "2026-11-17T11:00:00.000Z",
            event: "release",
            workspace: "ws-a",
            ticket: "SW-1",
            pr: PR_A,
            tag: "v1",
          }),
        ];
        const sliceB = [
          line({
            at: "2026-11-18T05:00:00.000Z",
            event: "pr.merged",
            workspace: "ws-b",
            ticket: "APP-7",
            pr: PR_B,
          }),
          line({
            at: "2026-11-18T06:00:00.000Z",
            event: "release",
            workspace: "ws-b",
            ticket: "APP-7",
            pr: PR_B,
            tag: "v2",
          }),
        ];
        const usage = (workspace, ticket, firstTurn, closedAt, estUsd, model) =>
          JSON.stringify({
            schema: 1,
            workspace,
            ticket,
            closedAt,
            firstTurn,
            estUsd,
            totals: { input: 10, output: 1, cacheCreation: 0, cacheRead: 0 },
            activeMinutes: 5,
            wallClockMinutes: 60,
            turns: 2,
            byModel: [
              { model, totals: { input: 10, output: 1, cacheCreation: 0, cacheRead: 0 }, estUsd },
            ],
          });

        const work = path.join(root, "work");
        fs.mkdirSync(work);
        git(work, "init", "-q", "-b", "main");
        const commitAs = (email, files) => {
          for (const [rel, body] of Object.entries(files))
            fs.writeFileSync(path.join(work, rel), `${body}\n`);
          git(work, "add", "-A");
          git(
            work,
            "-c",
            `user.email=${email}`,
            "-c",
            "user.name=n",
            "commit",
            "-q",
            "-m",
            "close-out",
          );
        };
        commitAs("t@t", { "README.md": "scaffold" });
        git(work, "checkout", "-q", "-b", "a/ws-a");
        commitAs("a@x", {
          "metrics.jsonl": sliceA.join("\n"),
          "usage.json": usage(
            "ws-a",
            "SW-1",
            "2026-11-17T01:00:00.000Z",
            "2026-11-17T12:00:00.000Z",
            2,
            "opus",
          ),
        });
        git(work, "checkout", "-q", "main");
        git(work, "checkout", "-q", "-b", "b/ws-b");
        commitAs("b@x", {
          "metrics.jsonl": sliceB.join("\n"),
          "usage.json": usage(
            "ws-b",
            "APP-7",
            "2026-11-18T00:00:00.000Z",
            "2026-11-18T07:00:00.000Z",
            1,
            "haiku",
          ),
        });
        git(work, "checkout", "-q", "main");
        const origin = path.join(root, "origin.git");
        git(root, "clone", "-q", "--bare", work, origin);
        fs.mkdirSync(path.join(os.homedir(), "repos"));
        git(root, "clone", "-q", origin, path.join(os.homedir(), "repos", "sandbox-workspace"));
        fs.mkdirSync(path.join(os.homedir(), "ws"));
        // Person A's own machine: their live log already holds their slice, verbatim.
        fs.mkdirSync(path.join(sandboxHome(), "metrics"), { recursive: true });
        fs.writeFileSync(
          path.join(sandboxHome(), "metrics", "events-2026-11.jsonl"),
          `${sliceA.join("\n")}\n`,
        );

        const first = await rebuildMetrics();
        const lines = logLines();
        assert.equal(
          lines.filter((e) => e.workspace === "ws-a").length,
          3,
          "A's own lines are not re-added",
        );
        assert.deepEqual(
          lines.filter((e) => e.workspace === "ws-b").map((e) => e.event),
          ["pr.merged", "release"],
          "B's slice arrives",
        );
        assert.equal(first.usages, 2);
        const cache = fs
          .readFileSync(path.join(sandboxHome(), "metrics", "usage-branches.jsonl"), "utf8")
          .trimEnd()
          .split("\n")
          .map((l) => JSON.parse(l));
        assert.deepEqual(cache.map((u) => [u.workspace, u.by]).sort(), [
          ["ws-a", "a@x"],
          ["ws-b", "b@x"],
        ]);
        for (const f of fs.readdirSync(path.join(sandboxHome(), "metrics")))
          assert.ok(
            path.join(sandboxHome(), "metrics", f).startsWith(home),
            "writes stay under the temp home",
          );
        assert.equal((await rebuildMetrics()).total, 0, "a second run adds nothing");

        const r = await metricsReport({ range: "all" }, new Date("2026-11-20T12:00:00.000Z"));
        assert.deepEqual(
          r.tickets.map((t) => [t.workspace, t.leadMinutes]),
          [
            ["ws-a", 600],
            ["ws-b", 360],
          ],
        );
        assert.deepEqual(r.lead, { p50Minutes: 360, p90Minutes: 600 });
        assert.equal(r.releases.total, 2);
        assert.deepEqual(Object.keys(r.usage.byPerson).sort(), ["a@x", "b@x"]);
        assert.deepEqual(r.usage.byPerson["a@x"].lead, { p50Minutes: 600, p90Minutes: 600 });
        assert.equal(r.usage.byPerson["b@x"].estUsd, 1);
        assert.deepEqual(Object.keys(r.usage.byProject).sort(), ["APP", "SW"]);
        assert.deepEqual(Object.keys(r.usage.byModel).sort(), ["haiku", "opus"]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

/** A gh serving o/app's CI coverage artifacts for runs 501 (merge queue) and 502 (pull request), else the seed's fake. */
function ciGh(fx) {
  const dir = path.join(fx.root, "ci-gh");
  fs.mkdirSync(dir);
  const artifacts = [501, 502, 400].map((id) => ({ expired: id === 400, workflow_run: { id } }));
  fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify({ artifacts }));
  const pkg = {
    version: "0.9.1",
    lines: 54.8,
    branches: 52.82,
    functions: 34.15,
    statements: 54.8,
  };
  for (const [run, event, commit] of [
    ["501", "merge_group", "aaaaaaaa1111"],
    ["502", "pull_request", "bbbbbbbb2222"],
  ])
    fs.writeFileSync(
      path.join(dir, `summary-${run}.json`),
      JSON.stringify({
        schema: 1,
        generatedAt: "2026-11-20T09:00:00.000Z",
        commit,
        ci: { event, run },
        packages: {
          "werkmeister-core": { ...pkg, tests: 1715, duration_ms: 121000 },
          "werkmeister-dashboard": { ...pkg, version: "0.1.0", tests: null, duration_ms: 17000 },
        },
      }),
    );
  const bin = path.join(dir, "gh");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
case "$1 $2" in
  "api repos/o/app/actions/artifacts?name=coverage-summary&per_page=100") cat "${dir}/artifacts.json" ;;
  "run download")
    echo "$3" >> "${dir}/downloads"
    run=$3
    while [ $# -gt 0 ]; do [ "$1" = -D ] && d=$2; shift; done
    cp "${dir}/summary-$run.json" "$d/summary.json" ;;
  *) exec "${fx.gh}" "$@" ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    bin,
    downloads: () =>
      fs.readFileSync(path.join(dir, "downloads"), "utf8").split("\n").filter(Boolean),
  };
}

test("rebuild imports each CI run's coverage once: merge queue as ci-main, PRs as ci-pr (SW-405)", async () => {
  await withSandboxHome(
    async (home) => {
      const fx = seed();
      const gh = ciGh(fx);
      const prevGh = process.env.WERKMEISTER_GH_BIN;
      process.env.WERKMEISTER_GH_BIN = gh.bin;
      try {
        const first = await rebuildMetrics();
        assert.equal(first.added.coverage, 4);
        const rows = logLines()
          .filter((e) => e.event === "coverage")
          .map((e) => [e.run, e.source, e.package, e.commit, e.version, e.tests, e.at]);
        assert.deepEqual(rows, [
          [
            "501",
            "ci-main",
            "werkmeister-core",
            "aaaaaaaa1111",
            "0.9.1+aaaaaaaa",
            1715,
            "2026-11-20T09:00:00.000Z",
          ],
          [
            "501",
            "ci-main",
            "werkmeister-dashboard",
            "aaaaaaaa1111",
            "0.1.0+aaaaaaaa",
            undefined,
            "2026-11-20T09:00:00.000Z",
          ],
          [
            "502",
            "ci-pr",
            "werkmeister-core",
            "bbbbbbbb2222",
            "0.9.1+bbbbbbbb",
            1715,
            "2026-11-20T09:00:00.000Z",
          ],
          [
            "502",
            "ci-pr",
            "werkmeister-dashboard",
            "bbbbbbbb2222",
            "0.1.0+bbbbbbbb",
            undefined,
            "2026-11-20T09:00:00.000Z",
          ],
        ]);
        assert.ok(metricsPathUnder(home));
        const second = await rebuildMetrics();
        assert.equal(second.added.coverage, 0);
        assert.deepEqual(
          gh.downloads(),
          ["501", "502"],
          "a logged run, or an expired artifact, is never downloaded",
        );
      } finally {
        if (prevGh === undefined) delete process.env.WERKMEISTER_GH_BIN;
        else process.env.WERKMEISTER_GH_BIN = prevGh;
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

const metricsPathUnder = (home) =>
  fs
    .readdirSync(path.join(sandboxHome(), "metrics"))
    .every((f) => path.join(sandboxHome(), "metrics", f).startsWith(home));

const TEAM_CONFIG = { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" };

/** An origin with one record branch per entry of *branches* ({ name, email, files }) and the shared checkout cloned from it. */
function teamRepo(branches) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-")));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const commitAs = (email, files) => {
    for (const [rel, body] of Object.entries(files))
      fs.writeFileSync(path.join(work, rel), `${body}\n`);
    git(work, "add", "-A");
    git(work, "-c", `user.email=${email}`, "-c", "user.name=n", "commit", "-q", "-m", "c");
  };
  commitAs("t@t", { "README.md": "scaffold" });
  for (const b of branches) {
    git(work, "checkout", "-q", "-b", b.name, "main");
    commitAs(b.email, b.files);
  }
  git(work, "checkout", "-q", "main");
  const origin = path.join(root, "origin.git");
  git(root, "clone", "-q", "--bare", work, origin);
  fs.mkdirSync(path.join(os.homedir(), "repos"));
  git(root, "clone", "-q", origin, path.join(os.homedir(), "repos", "sandbox-workspace"));
  fs.mkdirSync(path.join(os.homedir(), "ws"));
  return root;
}

// SW-1116: a slice line from a later version (v: 2) of an event with no keyOf key is copied as is, so a rebuild finds it next time.
test("a teammate's v: 2 slice line is copied verbatim and only once over two rebuilds (SW-1116)", async () => {
  await withSandboxHome(async (home) => {
    const line = JSON.stringify({
      v: 2,
      at: "2026-11-18T05:00:00.000Z",
      event: "issue.start",
      workspace: "ws-b",
      ticket: "APP-7",
    });
    // `at` names the month file: a path or a non-time is refused, not copied.
    const bad = ["../../evil", "2026-11-xx"].map((at) =>
      JSON.stringify({ v: 1, at, event: "issue.start", workspace: "ws-b", ticket: "APP-7" }),
    );
    const slice = [line, ...bad].join("\n");
    const root = teamRepo([{ name: "b/ws-b", email: "b@x", files: { "metrics.jsonl": slice } }]);
    try {
      assert.equal((await rebuildMetrics()).added["issue.start"], 1, "counted");
      await rebuildMetrics();
      const file = path.join(sandboxHome(), "metrics", "events-2026-11.jsonl");
      assert.ok(file.startsWith(home), "written under the temp home");
      assert.deepEqual(fs.readFileSync(file, "utf8").split("\n").filter(Boolean), [line]);
      assert.deepEqual(
        fs.readdirSync(path.join(sandboxHome(), "metrics")).sort(),
        ["events-2026-11.jsonl", "usage-branches.jsonl"],
        "no file from a bad at",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, TEAM_CONFIG);
});
