// SW-292: the one seeded fixture built-CLI exercises and core tests share, replacing the
// hand-built seed the cli validate: text described (SW-234, SW-232, SW-251, SW-114).

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { jiraCreds } from "../dist/jira-rest.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { readLeases } from "../dist/scheduler_state.js";
import { initWorkspace, provisionWorkspace } from "../dist/workspace_init.js";
import { tokensDir } from "../dist/workspace_token.js";
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
    assert.match(fs.readFileSync(path.join(fx.root, "ports.yaml"), "utf8"), /base_port: 29100/);
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

// SW-899: a listen(0) server or client socket on the gate's probed port fails the gate as "held by a host process".
test("the fixture's port block sits below the kernel's ephemeral range", {
  skip: process.platform !== "linux" && "reads /proc/sys/net/ipv4/ip_local_port_range",
}, async () => {
  const range = fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
  const low = Number(range.trim().split(/\s+/)[0]);
  await withFixtureWorkspace(async (fx) => {
    const ports = fs.readFileSync(path.join(fx.root, "ports.yaml"), "utf8");
    const [base, count, per] = ["base_port", "count", "ports_per_slot"].map((k) =>
      Number(new RegExp(`${k}: (\\d+)`).exec(ports)?.[1]),
    );
    // Slots run 1..count, so the block ends below base + (count + 1) * per.
    assert.ok(base + (count + 1) * per <= low, `${base}+ reaches the ephemeral ${low}+`);
  });
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

// SW-635: only init was covered, so create could go back to "Workspace ready." on a full machine;
// and init's next-step banner repeated create's.
test("create with every slot taken (slotsFull) names the path and prints the next step once", async () => {
  await withFixtureWorkspace(
    async () => {
      const reporter = collectingReporter();
      const dir = await withReporter(reporter, () =>
        provisionWorkspace({ feature: "nospace", repos: "app" }, { build: false }),
      );
      const out = reporter.text();
      assert.doesNotMatch(out, /Workspace ready\./);
      assert.match(
        out,
        new RegExp(`Workspace created at ${dir}, but its containers are not set up`),
      );
      assert.doesNotMatch(out, /container step did not run/i, "init's banner is dropped");
      // generate.ts's slot warning ("rerun … here") stays, as SW-635 asks; create's line says it once.
      assert.equal(out.match(/then run `werkmeister workspace init` there/g)?.length, 1, out);
    },
    { slotsFull: true },
  );
});

// SW-581: the config sits at the temp HOME's default path, so `machine migrate` runs against the fixture.
test("the fixture's config is the temp HOME's ~/.werkmeister/config.yaml", async () => {
  await withFixtureWorkspace(async (fx) => {
    assert.equal(fx.configFile, path.join(fx.env.HOME, ".werkmeister", "config.yaml"));
  });
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

test("in-process, HOME is the fixture's, so anything written under ~ stays in it", async () => {
  const real = os.homedir();
  await withFixtureWorkspace(async (fx) => {
    assert.equal(os.homedir(), path.join(fx.root, "home"));
    assert.ok(tokensDir().startsWith(`${fx.root}/`), tokensDir());
  });
  assert.equal(os.homedir(), real, "restored after");
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
  const { resolveClaudeBin } = await import("../dist/harness/claude/cli.js");
  const { refreshKubeconfig } = await import("../dist/k8s.js");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "caller-bin-"));
  const hits = path.join(bin, "hits");
  for (const name of ["claude", "kubectl"])
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> "${hits}"\n`, {
      mode: 0o755,
    });
  const creds = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "KUBECONFIG", "GH_TOKEN"];
  const prev = Object.fromEntries(["PATH", ...creds].map((k) => [k, process.env[k]]));
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
  const { callTool } = await import("../dist/daemon_client.js");
  await withFakeDaemon(
    async (daemon) => {
      // SW-708: refused like a stopped daemon, not fetch's "bad port" TypeError (no cause.code) on port 1.
      await withFixtureWorkspace(async () => {
        assert.notEqual(process.env.WERKMEISTER_HOST, daemon.url);
        await assert.rejects(fetch(process.env.WERKMEISTER_HOST), (e) => {
          assert.equal(e.cause?.code, "ECONNREFUSED");
          return true;
        });
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

// SW-718: the CLI's build-header lookup threw before the request, so `feature stop --via-daemon` never called.
test("callTool still calls the daemon when the build-header lookup throws", async () => {
  const { callTool, expectDaemonBuild } = await import("../dist/daemon_client.js");
  await withFakeDaemon(
    async (daemon) => {
      expectDaemonBuild(() => {
        throw new Error("Could not locate the werkmeister CLI package");
      });
      try {
        await withFixtureWorkspace(
          async () => {
            assert.deepEqual((await callTool("stop", {}, { token: "t" })).data, { ok: 1 });
          },
          { daemon: daemon.url },
        );
      } finally {
        expectDaemonBuild(() => null);
      }
      assert.equal(daemon.calls.filter((c) => c.startsWith("POST /api/tool")).length, 1);
    },
    { stop: { ok: 1 } },
  );
});

// SW-548: inside a werkmeister container the worktree is mounted at /app and at its host path, but its
// node_modules is a volume at /app/node_modules only, so the host-path CLI fails ERR_MODULE_NOT_FOUND.
test("with-fixture-workspace runs /app's CLI when /app is its worktree, and says why on a host with no node_modules (SW-548)", async () => {
  const { writeFixtureWrapper } = await import("../dist/temp_home.js");
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

// SW-1108: a workflow folder seeded where init looks for it, never outside the fixture.
const WORKFLOW = {
  type: "review",
  files: {
    "workflow.yaml":
      "version: 1\nstages:\n  - name: triage\n    job: sort it\n    writes: out.md\n    check: read it\n",
    "stages/triage.md": "One job: sort it.\n",
  },
};

test("workflow seeds the temp HOME's workflows/<type>/ and makes the workspace icm of that type", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const dir = path.join(fx.env.HOME, ".werkmeister", "workflows", "review");
      assert.equal(fx.workflowDir, dir);
      assert.ok(dir.startsWith(`${fx.root}/home/`), dir);
      assert.equal(
        fs.readFileSync(path.join(dir, "stages", "triage.md"), "utf8"),
        "One job: sort it.\n",
      );
      const yml = fs.readFileSync(path.join(fx.workspace, ".werkmeister", "workspace.yml"), "utf8");
      assert.match(yml, /context_strategy: icm/);
      assert.match(yml, /work_type: review/);
    },
    { workflow: WORKFLOW },
  );
});

test("workflow in: repo commits it to the code repo's main, so the branch adds no change", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      assert.equal(fx.workflowDir, path.join(fx.repo, ".werkmeister", "workflows", "review"));
      assert.equal(fs.existsSync(path.join(fx.env.HOME, ".werkmeister", "workflows")), false);
      assert.equal(
        git(
          fx.repo,
          "ls-tree",
          "-r",
          "--name-only",
          "origin/main",
          ".werkmeister/workflows/review",
        ),
        ".werkmeister/workflows/review/stages/triage.md\n.werkmeister/workflows/review/workflow.yaml",
      );
      assert.equal(git(fx.repo, "status", "--porcelain"), "");
    },
    { workflow: { ...WORKFLOW, in: "repo" } },
  );
});

test("workflow refuses a name init can't find, a stray file and another work_type", async () => {
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  assert.throws(
    () => fixturePreset({ workflow: { ...WORKFLOW, type: "Review" } }),
    /not a work type/,
  );
  assert.throws(
    () => fixturePreset({ workflow: { ...WORKFLOW, files: { ...WORKFLOW.files, "run.sh": "" } } }),
    /run\.sh: only workflow\.yaml/,
  );
  assert.throws(
    () => fixturePreset({ workflow: WORKFLOW, workspace: { work_type: "feature" } }),
    /would leave the review workflow unused/,
  );
  // SW-1120: a jit workspace file would init without reading the workflow, and exit 0.
  assert.throws(
    () => fixturePreset({ workflow: WORKFLOW, workspace: { context_strategy: "jit" } }),
    /context_strategy jit would leave the review workflow unused/,
  );
  assert.doesNotThrow(() =>
    fixturePreset({ workflow: WORKFLOW, workspace: { context_strategy: "icm" } }),
  );
});
