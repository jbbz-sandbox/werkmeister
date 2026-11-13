// SW-292: the one seeded fixture built-CLI exercises and core tests share, replacing the
// hand-built seed the cli validate: text described (SW-234, SW-232, SW-251, SW-114).

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { jiraCreds } from "./dist/jira-rest.js";
import { gatePrs } from "./dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { hostLoadLimit, readLeases } from "./dist/scheduler_state.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { tokensDir } from "./dist/workspace_token.js";
import { pinWerkmeisterRoot, withFakeDaemon, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("the fixture seeds a registry, a workspace and a code repo with a local origin", async () => {
  await withFixtureWorkspace(async (fx) => {
    assert.equal(process.env.WERKMEISTER_CONFIG_FILE, fx.configFile);
    assert.equal(process.env.WERKMEISTER_FIXTURE, "1");
    const config = fs.readFileSync(fx.configFile, "utf8");
    for (const key of ["repos_root", "workspaces_root", "services_yaml", "ports_yaml"])
      assert.match(config, new RegExp(`${key}: ${fx.root}/`));
    assert.equal(fs.lstatSync(path.join(fx.root, "services.yaml")).isSymbolicLink(), false);
    assert.match(fs.readFileSync(path.join(fx.root, "ports.yaml"), "utf8"), /base_port: 39100/);
    assert.match(
      fs.readFileSync(path.join(fx.workspace, ".werkmeister", "workspace.yml"), "utf8"),
      /^feature: demo$/m,
    );
    assert.equal(git(fx.repo, "branch", "--show-current"), "me/demo");
    assert.equal(
      git(fx.repo, "remote", "get-url", "origin"),
      path.join(fx.root, "remotes/o/app.git"),
    );
    assert.equal(
      git(path.join(fx.root, "repos/app"), "branch", "--show-current"),
      "fixture-source",
    );
  });
  assert.equal(process.env.WERKMEISTER_FIXTURE, undefined, "env restored");
});

test("a bare fixture has no feature, so close-out skips teardown (SW-114)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const yml = fs.readFileSync(path.join(fx.workspace, ".werkmeister", "workspace.yml"), "utf8");
      assert.doesNotMatch(yml, /^(feature|issue_id):/m);
    },
    { bare: true },
  );
});

// SW-218: init cost ~10 s per call while slots.ts's container query waited out its 10 s
// timeout on the host engine; SW-259's dead socket in tests fails it at once.
test("init under the fixture writes the context and wrappers inside the 10 s query timeout", async () => {
  await withFixtureWorkspace(async (fx) => {
    const t0 = performance.now();
    await withReporter(collectingReporter(), () =>
      initWorkspace({}, fx.workspace, { build: false }),
    );
    const ms = performance.now() - t0;
    // Measured ~0.5 s. The bound only has to fail the SW-218 regression it guards, an init that
    // waits out the 10 s engine-query timeout, and hold under the load the pr gate's parallel
    // builds create, where init took up to 7.1 s (SW-553). No load signal widens it: in the
    // container os.loadavg() is the Linux VM's, which never sees the macOS host's contention.
    assert.ok(ms < 9000, `init took ${Math.round(ms)} ms`);
    const bin = path.join(fx.workspace, ".werkmeister", "bin");
    assert.ok(fs.statSync(path.join(bin, "with-fixture-workspace")).mode & 0o100);
    assert.match(
      fs.readFileSync(path.join(fx.workspace, ".werkmeister", "werkmeister-context.md"), "utf8"),
      /`lib`/,
    );
  });
});

// SW-551: with every slot leased, init skipped compose.yml and the context but still ended
// "Workspace initialised.", so create handed the agent a container recipe it could not follow.
test("init with every slot taken (slotsFull) says the container step did not run and what to do", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      // SW-634: each lease's workspace must exist, or heldSlots prunes it and init gets a slot.
      const leases = Object.entries(readLeases()).sort(([, a], [, b]) => a.slot - b.slot);
      assert.deepEqual(
        leases.map(([f, l]) => [f, l.slot]),
        [1, 2, 3, 4].map((n) => [`other-${n}`, n]),
      );
      for (const [, l] of leases) assert.ok(fs.existsSync(l.workspace), l.workspace);
      const reporter = collectingReporter();
      const result = await withReporter(reporter, () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const out = reporter.text();
      assert.equal(fs.existsSync(path.join(fx.workspace, "compose.yml")), false);
      assert.equal(result.containers, false);
      assert.doesNotMatch(out, /Workspace initialised\./);
      assert.match(out, /container step did not run/i);
      assert.match(out, /werkmeister feature down/);
      assert.match(out, /werkmeister workspace init/);
      // The stage contracts send the agent here for the container recipe, so it says so too.
      const context = fs.readFileSync(
        path.join(fx.workspace, ".werkmeister", "werkmeister-context.md"),
        "utf8",
      );
      assert.match(context, /container step did not run/i);
      assert.match(context, /All 4 feature slots are occupied|No available slots/);
      assert.match(context, /werkmeister workspace init/);
    },
    { slotsFull: true },
  );
});

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

test("--change names the file the gate fixture changes, beside a fragment change too (SW-664)", async () => {
  const { fixturePreset } = await import("./dist/fixture_workspace.js");
  assert.deepEqual(fixturePreset({ gate: true }).repos, [
    { name: "app", change: "packages/lib/index.js" },
  ]);
  assert.deepEqual(fixturePreset({ gate: true, change: "plugins/x/y.ts" }).repos, [
    { name: "app", change: "plugins/x/y.ts" },
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

test("init refuses a repo name that leaves repos_root, before touching any repo", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await assert.rejects(
        withReporter(collectingReporter(), () => initWorkspace({}, fx.workspace, { build: false })),
        /must be a folder directly under .*: \.\.\/outside/,
      );
    },
    { workspace: { repos: "app,../outside" } },
  );
});

test("caller-exported Jira credentials don't reach a fixture run", async () => {
  const prev = process.env.JIRA_API_TOKEN;
  Object.assign(process.env, {
    JIRA_BASE_URL: "https://real.atlassian.net",
    JIRA_EMAIL: "me@example.com",
    JIRA_API_TOKEN: "secret",
  });
  try {
    await withFixtureWorkspace(async () => assert.equal(await jiraCreds(), null));
    assert.equal(process.env.JIRA_API_TOKEN, "secret", "restored after");
  } finally {
    for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];
    if (prev !== undefined) process.env.JIRA_API_TOKEN = prev;
  }
});

test("config adds keys to the fixture's config.yaml, and any key but budget is refused (SW-670)", async () => {
  const { fixturePreset } = await import("./dist/fixture_workspace.js");
  await withFixtureWorkspace(
    async () => {
      assert.equal(hostLoadLimit(8), 0.01);
    },
    { config: { budget: { host_load: 0.01 } } },
  );
  for (const key of ["version", "paths", "overrides", "projects", "jira", "github_ingest"])
    assert.throws(() => fixturePreset({ config: { [key]: {} } }), /--config may not set/);
});

test("in-process, HOME is the fixture's, so anything written under ~ stays in it", async () => {
  const real = os.homedir();
  await withFixtureWorkspace(async (fx) => {
    assert.equal(os.homedir(), path.join(fx.root, "home"));
    assert.ok(tokensDir().startsWith(`${fx.root}/`), tokensDir());
  });
  assert.equal(os.homedir(), real, "restored after");
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

test("the workspace folder is a git repo with a local origin, its code clone ignored", async () => {
  await withFixtureWorkspace(async (fx) => {
    assert.equal(git(fx.workspace, "branch", "--show-current"), "me/demo");
    assert.equal(git(fx.workspace, "status", "--porcelain"), "");
    assert.equal(git(fx.workspace, "rev-parse", "@{u}"), git(fx.workspace, "rev-parse", "HEAD"));
    assert.equal(
      git(fx.workspace, "remote", "get-url", "origin"),
      path.join(fx.root, "remotes/o/ws.git"),
    );
  });
});

// SW-424: a fixture step must not reach the caller's claude, kubectl or credentials.
test("under the fixture, claude and kubectl are not the caller's, and its credentials are blank", async () => {
  const { resolveClaudeBin } = await import("./dist/harness/claude/cli.js");
  const { refreshKubeconfig } = await import("./dist/k8s.js");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "caller-bin-"));
  const hits = path.join(bin, "hits");
  for (const name of ["claude", "kubectl"])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> "${hits}"\n`, {
      mode: 0o755,
    });
  const creds = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "KUBECONFIG", "GH_TOKEN"];
  const prev = Object.fromEntries(["PATH", "CLAUDE_BIN", ...creds].map((k) => [k, process.env[k]]));
  delete process.env.CLAUDE_BIN;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  for (const k of creds) process.env[k] = "caller-secret";
  try {
    await withFixtureWorkspace(async () => {
      for (const k of creds) assert.equal(process.env[k] || "", "", k);
      const claude = await resolveClaudeBin();
      try {
        execFileSync(claude, ["-p", "hi"], { stdio: "ignore" });
      } catch {}
      await withReporter(collectingReporter(), () => refreshKubeconfig());
    });
    assert.equal(fs.existsSync(hits) ? fs.readFileSync(hits, "utf8") : "", "", "caller's bins ran");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// SW-426: a shell exporting the real daemon's address must not reach it from a fixture.
test("WERKMEISTER_HOST is dead under the fixture unless it is given a fake daemon", async () => {
  const { callTool } = await import("./dist/daemon_client.js");
  await withFakeDaemon(
    async (daemon) => {
      await withFixtureWorkspace(async () => {
        assert.equal(process.env.WERKMEISTER_HOST, "http://127.0.0.1:1");
      });
      await withFixtureWorkspace(
        async () => {
          assert.deepEqual((await callTool("status", {}, { token: "t" })).data, { ok: 1 });
          await assert.rejects(
            callTool("up", {}, { token: "t" }),
            /fake daemon: unhandled tool up/,
          );
        },
        { daemon: daemon.url },
      );
      assert.equal(daemon.calls.filter((c) => c.startsWith("POST /api/tool")).length, 2);
    },
    { status: { ok: 1 } },
  );
});

test("--gate refuses a registry whose change would map to no service (SW-426)", async () => {
  const { fixturePreset } = await import("./dist/fixture_workspace.js");
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

// SW-548: inside a werkmeister container the worktree is mounted at /app and at its host path, but its
// node_modules is a volume at /app/node_modules only, so the host-path CLI fails ERR_MODULE_NOT_FOUND.
test("with-fixture-workspace runs /app's CLI when /app is its worktree, and says why on a host with no node_modules (SW-548)", async () => {
  const { writeFixtureWrapper } = await import("./dist/fixture_workspace.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fixture-wrapper-")));
  try {
    const ws = path.join(tmp, "ws");
    const wt = path.join(ws, "wt");
    fs.mkdirSync(path.join(wt, "apps", "cli", "dist"), { recursive: true });
    fs.mkdirSync(path.join(wt, "node_modules"));
    fs.writeFileSync(
      path.join(wt, "apps", "cli", "dist", "main.js"),
      "console.log(process.argv[1])\n",
    );
    const script = writeFixtureWrapper(ws);
    // A stand-in for with-temp-home: drop --no-wait, run the rest.
    fs.writeFileSync(
      path.join(path.dirname(script), "with-temp-home"),
      '#!/bin/sh\n[ "$1" != --no-wait ] || shift\nexec "$@"\n',
      { mode: 0o755 },
    );
    const text = fs.readFileSync(script, "utf8");
    assert.match(text, /^app=\/app$/m);
    const run = (app) => {
      fs.writeFileSync(script, text.replace(/^app=\/app$/m, `app=${app}`));
      return new Promise((resolve) =>
        execFile(script, ["--no-wait", "x"], (e, stdout, stderr) =>
          resolve(e ? { code: e.code, out: stderr } : { code: 0, out: stdout.trim() }),
        ),
      );
    };
    const own = path.join(wt, "apps", "cli", "dist", "main.js");
    // Host, no /app: an empty node_modules (the container's mount point) fails with the container form.
    const r = await run(path.join(tmp, "none"));
    assert.equal(r.code, 2);
    assert.match(r.out, /no node_modules.*docker exec -w \/app/s);
    // Host with an install: unchanged.
    fs.writeFileSync(path.join(wt, "node_modules", ".modules.yaml"), "");
    assert.deepEqual(await run(path.join(tmp, "none")), { code: 0, out: own });
    // An /app that is another folder: unchanged.
    fs.mkdirSync(path.join(tmp, "other"));
    assert.deepEqual(await run(path.join(tmp, "other")), { code: 0, out: own });
    // In the container: /app is the same folder as the worktree, so its CLI runs from /app.
    fs.symlinkSync(wt, path.join(tmp, "app"));
    assert.deepEqual(await run(path.join(tmp, "app")), {
      code: 0,
      out: path.join(tmp, "app", "apps", "cli", "dist", "main.js"),
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
