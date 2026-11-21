// Split from fixture-workspace.test.mjs so no one file holds most of the fixture tests (SW-881): the gate preset's PR file, change and fake docker.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { defaultDeps, gatePrs, openPrs } from "../dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("the gate fixture's one-file change runs lib's test in its container, logged by the fake docker", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      // The gate's setup one-shot re-run starts from compose.yml, which init writes (SW-362).
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const { ok, lines } = await gatePrs(fx.workspace);
      assert.equal(ok, true, lines.join("\n"));
      const calls = fs.readFileSync(fx.dockerLog, "utf8").split("\n");
      const execs = calls.filter((c) => c.startsWith("exec "));
      assert.equal(execs.length, 1, calls.join("\n"));
      // Logged as container + row command, not the inlined script (SW-511).
      assert.match(execs[0], /^exec demo-lib true$/);
    },
    { gate: true },
  );
});

test("a gate fixture behind origin/main fails the base row after a fetch, before any docker exec (SW-669)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      assert.equal(
        git(fx.repo, "rev-list", "--count", "HEAD..origin/main"),
        "0",
        "stale until fetched",
      );
      const { ok, lines } = await gatePrs(fx.workspace);
      assert.equal(ok, false);
      const out = lines.join("\n");
      assert.match(out, /✗ base: 2 commits behind origin\/main — `git -C app rebase origin\/main`/);
      assert.match(out, /✗ tests: not run — fix the rows above first/);
      const calls = fs.existsSync(fx.dockerLog) ? fs.readFileSync(fx.dockerLog, "utf8") : "";
      assert.doesNotMatch(calls, /^exec /m);
      // After the rebase the command names, the same gate passes.
      git(fx.repo, "rebase", "-q", "origin/main");
      const again = await gatePrs(fx.workspace);
      assert.equal(again.ok, true, again.lines.join("\n"));
      assert.match(again.lines.join("\n"), /✓ base: up to date with origin\/main/);
    },
    { gate: true, behind: true },
  );
});

/** openPrs on the inited gate fixture, with its waits stubbed. */
async function openFixture(fx) {
  await withReporter(collectingReporter(), () => initWorkspace({}, fx.workspace, { build: false }));
  const deps = defaultDeps();
  deps.sleep = async () => {};
  const r = await openPrs(fx.workspace, undefined, deps);
  const calls = fs.existsSync(fx.dockerLog) ? fs.readFileSync(fx.dockerLog, "utf8") : "";
  return { ...r, out: r.lines.join("\n"), calls };
}

test("pr open on a gate fixture behind origin/main rebases by itself, tests and opens (SW-857)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const { ok, out, calls } = await openFixture(fx);
      assert.equal(ok, true, out);
      assert.match(out, /✓ base: rebased onto origin\/main \(was 2 commits behind origin\/main\)/);
      git(fx.repo, "merge-base", "--is-ancestor", "origin/main", "HEAD");
      assert.match(calls, /^exec /m, "the tests ran on the rebased branch");
    },
    { gate: true, behind: true },
  );
});

test("pr open on a fixture whose branch and main change the same file aborts the rebase (SW-857)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const head = git(fx.repo, "rev-parse", "HEAD");
      const { ok, out, calls } = await openFixture(fx);
      assert.equal(ok, false);
      assert.match(
        out,
        /✗ base: 2 commits behind origin\/main; auto-rebase onto origin\/main conflicts in x\.txt — aborted, branch unchanged/,
      );
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), head);
      const gitDir = git(fx.repo, "rev-parse", "--absolute-git-dir");
      assert.ok(!fs.existsSync(path.join(gitDir, "rebase-merge")), "no rebase left in progress");
      assert.ok(!fs.existsSync(path.join(gitDir, "rebase-apply")), "no rebase left in progress");
      assert.equal(git(fx.repo, "status", "--porcelain"), "");
      assert.doesNotMatch(calls, /^exec /m);
    },
    { gate: true, behind: true, change: "x.txt" },
  );
});

// SW-664: a diff touching only the registry fragment, so the gate's fragment row is exercised end to end.
test("a gate fixture with fragmentChange gates a fragment-only diff and runs only the service it changes", async () => {
  const branch = `services:\n  lib:\n    type: cli\n    path: packages/lib\n    test: echo changed\nrepo:\n  path_mappings:\n    packages/lib: lib\n`;
  await withFixtureWorkspace(
    async (fx) => {
      assert.equal(
        git(fx.repo, "diff", "--name-only", "origin/main...HEAD"),
        ".werkmeister/services.yaml",
      );
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const { ok, lines } = await gatePrs(fx.workspace);
      assert.equal(ok, true, lines.join("\n"));
      assert.match(lines.join("\n"), /fragment: \.werkmeister\/services\.yaml changes lib/);
      const execs = fs
        .readFileSync(fx.dockerLog, "utf8")
        .split("\n")
        .filter((c) => c.startsWith("exec "));
      assert.deepEqual(execs, ["exec demo-lib echo changed"]);
    },
    { gate: true, fragmentChange: branch },
  );
});

// SW-817: compose.yml inited before the branch's fragment lands, so the gate sees the branch settings as changed.
test("staleCompose holds the fragment back until applyFragmentChange, so the gate starts from compose.gate.yml", async () => {
  const branch = `services:\n  lib:\n    type: cli\n    path: packages/lib\n    test: echo changed\n    environment:\n      FIXTURE_FLAG: "1"\nrepo:\n  path_mappings:\n    packages/lib: lib\n`;
  await withFixtureWorkspace(
    async (fx) => {
      assert.equal(git(fx.repo, "diff", "--name-only", "origin/main...HEAD"), "");
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      fx.applyFragmentChange();
      assert.equal(
        git(fx.repo, "diff", "--name-only", "origin/main...HEAD"),
        ".werkmeister/services.yaml",
      );
      const { lines } = await gatePrs(fx.workspace);
      const calls = fs.readFileSync(fx.dockerLog, "utf8");
      assert.match(calls, /compose -f \S*compose\.gate\.yml .*up .*lib/, lines.join("\n"));
      assert.match(calls, /^exec demo-lib echo changed$/m, lines.join("\n"));
    },
    { gate: true, fragmentChange: branch, staleCompose: true },
  );
});

test("--change names the file the gate fixture changes, beside a fragment change too (SW-664)", async () => {
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  assert.deepEqual(fixturePreset({ gate: true }).repos, [
    { name: "app", change: "packages/lib/index.js" },
  ]);
  assert.deepEqual(fixturePreset({ gate: true, change: "plugins/x/y.ts" }).repos, [
    { name: "app", change: "plugins/x/y.ts", conflict: true },
  ]);
  assert.deepEqual(fixturePreset({ gate: true, fragmentChange: "x" }).repos, [
    { name: "app", change: undefined },
  ]);
  // Another path maps to no `lib`, so a --services registry without it is no longer refused.
  assert.doesNotThrow(() =>
    fixturePreset({
      gate: true,
      change: "docs/z.md",
      services: "services:\n  web: { repo: app, path: . }\n",
    }),
  );
  await withFixtureWorkspace(
    async (fx) => {
      assert.equal(
        git(fx.repo, "diff", "--name-only", "origin/main...HEAD"),
        ".werkmeister/services.yaml\nplugins/x/y.ts",
      );
    },
    { gate: true, change: "plugins/x/y.ts", fragmentChange: "services: {}\n" },
  );
});

test("the fake docker shows the gate's containers only to the gate's ps", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const docker = (...args) =>
        execFileSync(fx.env.WERKMEISTER_DOCKER_BIN, args, { encoding: "utf8" });
      assert.equal(docker("ps", "--format", "{{.Names}}\t{{.State}}"), "demo-lib\trunning\n");
      // A pre-rename project probe (compose.ts takeDownProject) must find nothing to take down.
      assert.equal(
        docker("ps", "-aq", "--filter", "label=com.docker.compose.project=sandbox-demo"),
        "",
      ); // name-check: ignore
      assert.equal(docker("ps", "-q", "--filter", "label=werkmeister.feature"), "");
    },
    { gate: true },
  );
});

test("--gate refuses a registry whose change would map to no service (SW-426)", async () => {
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  assert.throws(
    () => fixturePreset({ gate: true, services: "services:\n  web: { repo: app, path: . }\n" }),
    /--gate needs a `lib` service/,
  );
  // SW-447: the right repo at another path still maps the packages/lib change to no service.
  assert.throws(
    () =>
      fixturePreset({ gate: true, services: "services:\n  lib: { repo: app, path: libs/lib }\n" }),
    /--gate needs a `lib` service/,
  );
  assert.equal(fixturePreset({ gate: true }).running?.length, 1);
  // SW-470: without --gate a broken registry reaches workspace init's own error.
  assert.doesNotThrow(() => fixturePreset({ services: "{bad" }));
});

test("--pr-field status sets the gate PR file's status line verbatim, notes included (SW-549)", async () => {
  for (const [status, ok] of [
    ["approved  # approved via check-in 2026-11-06", true],
    ["approvd", false],
  ])
    await withFixtureWorkspace(
      async (fx) => {
        const pr = fs.readFileSync(
          path.join(fx.workspace, ".werkmeister", "notes", "pr-app.md"),
          "utf8",
        );
        assert.equal(pr.match(/^status: .*$/gm)?.join("|"), `status: ${status}`);
        await withReporter(collectingReporter(), () =>
          initWorkspace({}, fx.workspace, { build: false }),
        );
        const { ok: passed, lines } = await gatePrs(fx.workspace);
        assert.equal(passed, ok, lines.join("\n"));
        if (!ok) assert.match(lines.join("\n"), /✗ approved: status: approvd/);
      },
      { gate: true, prFields: { status } },
    );
});

test("prLines seeds a raw frontmatter line, so an unquoted colon value fails the gate's YAML parse (SW-851)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const pr = fs.readFileSync(
        path.join(fx.workspace, ".werkmeister", "notes", "pr-app.md"),
        "utf8",
      );
      assert.match(pr, /^skip_release: no changeset: test-only$/m);
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      await assert.rejects(gatePrs(fx.workspace), /Quote values that contain a colon/);
    },
    { gate: true, prLines: ["skip_release: no changeset: test-only"] },
  );
});
