// SW-292: the one seeded fixture built-CLI exercises and core tests share, replacing the
// hand-built seed the cli validate: text described (SW-234, SW-232, SW-251, SW-114).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { jiraCreds } from "./dist/jira-rest.js";
import { gatePrs } from "./dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
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
test("init under the fixture writes the context and wrappers well inside the 10 s query timeout", async () => {
  await withFixtureWorkspace(async (fx) => {
    const t0 = performance.now();
    await withReporter(collectingReporter(), () =>
      initWorkspace({}, fx.workspace, { build: false }),
    );
    const ms = performance.now() - t0;
    // Measured ~0.5 s; 2 s leaves room for a busy host (SW-426). Over its core count (any of the
    // 1/5/15-min loads) init took 2.2-3.5 s (SW-485), so the bound widens to 6 s,
    // still well under the 10 s timeout the SW-218 regression waits out.
    const overloaded = Math.max(...os.loadavg()) > os.cpus().length;
    assert.ok(
      ms < (overloaded ? 6000 : 2000),
      `init took ${Math.round(ms)} ms (overloaded: ${overloaded})`,
    );
    const bin = path.join(fx.workspace, ".werkmeister", "bin");
    assert.ok(fs.statSync(path.join(bin, "with-fixture-workspace")).mode & 0o100);
    assert.match(
      fs.readFileSync(path.join(fx.workspace, ".werkmeister", "werkmeister-context.md"), "utf8"),
      /`lib`/,
    );
  });
});

test("the gate fixture's one-file change runs lib's test in its container, logged by the fake docker", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      // The gate's setup one-shot re-run starts from compose.yml, which init writes (SW-362).
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const { ok, lines } = await gatePrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(ok, true, lines.join("\n"));
      const calls = fs.readFileSync(fx.dockerLog, "utf8").split("\n");
      const execs = calls.filter((c) => c.startsWith("exec "));
      // The gate wraps the test in an inline with-temp-home (SW-329); the test command comes last.
      assert.equal(execs.length, 1, calls.join("\n"));
      assert.match(execs[0], /^exec demo-lib sh -c .* sh -c true$/);
    },
    { gate: true },
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
});
