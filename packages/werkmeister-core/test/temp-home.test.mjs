// SW-124: the generated wrapper runs a command with a fresh temporary HOME and
// removes it on exit, so no test reaches the real ~/.werkmeister.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { tempHomeWrapper, writeTempHomeWrapper } from "../dist/temp_home.js";

// The wrapper calls the global werkmeister, which would wait on a loaded host; only the SW-224 tests below let it.
process.env.WERKMEISTER_NO_WAIT = "1";

function wrapper() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "temp-home-"));
  return { root, bin: writeTempHomeWrapper(root) };
}

test("written executable at .werkmeister/bin/with-temp-home, rewritten in place", () => {
  const { root, bin } = wrapper();
  try {
    assert.equal(bin, path.join(root, ".werkmeister", "bin", "with-temp-home"));
    assert.equal(tempHomeWrapper(root), bin);
    fs.chmodSync(bin, 0o644);
    writeTempHomeWrapper(root);
    assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the command sees a fresh HOME other than the caller's, gone after exit", () => {
  const { root, bin } = wrapper();
  try {
    const r = spawnSync(bin, ["sh", "-c", 'test -d "$HOME" && printf %s "$HOME"'], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const seen = r.stdout;
    assert.ok(seen, "printed a HOME");
    assert.notEqual(seen, process.env.HOME);
    assert.notEqual(seen, os.homedir());
    assert.ok(!fs.existsSync(seen), `${seen} removed after exit`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exit status passes through; no command is a usage error", () => {
  const { root, bin } = wrapper();
  try {
    assert.equal(spawnSync(bin, ["sh", "-c", "exit 3"]).status, 3);
    const none = spawnSync(bin, [], { encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /usage: with-temp-home/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failing command reports host load on stderr; a passing one prints nothing extra (SW-209)", () => {
  const { root, bin } = wrapper();
  try {
    const failed = spawnSync(bin, ["sh", "-c", "exit 3"], { encoding: "utf8" });
    assert.equal(failed.status, 3);
    assert.match(failed.stderr, /^with-temp-home: exit 3; host load [\d. ]+ on \d+ cores$/m);
    const passed = spawnSync(bin, ["true"], { encoding: "utf8" });
    assert.equal(passed.status, 0);
    assert.equal(passed.stderr, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corepack keeps the caller's cache unless COREPACK_HOME is already set", () => {
  const { root, bin } = wrapper();
  const corepackHome = (env) =>
    spawnSync(bin, ["sh", "-c", 'printf %s "$COREPACK_HOME"'], { encoding: "utf8", env }).stdout;
  try {
    const { COREPACK_HOME: _, ...env } = process.env;
    assert.equal(corepackHome({ ...env, HOME: "/caller" }), "/caller/.cache/node/corepack");
    assert.equal(corepackHome({ ...env, HOME: "/caller", COREPACK_HOME: "/mine" }), "/mine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-799: scratch dirs a wrapped command makes in os.tmpdir() go with the temp HOME.
test("TMPDIR is the temp HOME's own dir, so os.tmpdir() scratch is gone after exit (SW-799)", () => {
  const { root, bin } = wrapper();
  try {
    const r = spawnSync(
      bin,
      ["node", "-e", "console.log(require('os').tmpdir() + '\\n' + process.env.HOME)"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const [tmpdir, home] = r.stdout.trim().split("\n");
    assert.equal(tmpdir, home, "TMPDIR is the temp HOME");
    // realpath both sides: macOS's /var is a symlink to /private/var.
    assert.equal(
      fs.realpathSync(path.dirname(tmpdir)),
      fs.realpathSync(os.tmpdir()),
      "under the caller's temp dir",
    );
    assert.ok(!fs.existsSync(tmpdir), `${tmpdir} removed after exit`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-285: OrbStack and Docker Desktop keep the compose plugin and context under ~/.docker.
test("DOCKER_CONFIG keeps the caller's ~/.docker unless already set, exported before HOME swaps (SW-285)", () => {
  const { root, bin } = wrapper();
  const dockerConfig = (env) =>
    spawnSync(bin, ["sh", "-c", 'printf %s "$DOCKER_CONFIG"'], { encoding: "utf8", env }).stdout;
  try {
    const { DOCKER_CONFIG: _, ...env } = process.env;
    assert.equal(dockerConfig({ ...env, HOME: "/caller" }), "/caller/.docker");
    assert.equal(dockerConfig({ ...env, HOME: "/caller", DOCKER_CONFIG: "/mine" }), "/mine");
    const script = fs.readFileSync(bin, "utf8");
    assert.ok(script.indexOf("export DOCKER_CONFIG=") < script.indexOf("HOME=$tmp"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A stub `werkmeister` first on PATH that logs each call; *waitExit* is its exit status. */
function stubbedPath(root, waitExit = 0) {
  const bin = path.join(root, "stub-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "werkmeister"),
    `#!/bin/sh\necho "werkmeister $*" >> "${root}/calls"\necho "waiting for host load 90.0 to fall to 8"\nexit ${waitExit}\n`,
    { mode: 0o755 },
  );
  const { WERKMEISTER_NO_WAIT: _, ...env } = process.env;
  return { ...env, PATH: `${bin}:${process.env.PATH}` };
}
const calls = (root) =>
  fs.existsSync(path.join(root, "calls")) ? fs.readFileSync(path.join(root, "calls"), "utf8") : "";

test("waits through werkmeister wait-load on stderr, then runs the command once (SW-224)", () => {
  const { root, bin } = wrapper();
  try {
    const r = spawnSync(bin, ["sh", "-c", `echo "cmd" >> "${root}/calls"; printf out`], {
      encoding: "utf8",
      env: stubbedPath(root),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(root), "werkmeister internal wait-load\ncmd\n");
    assert.equal(r.stdout, "out", "the wait never writes to the command's stdout");
    assert.match(r.stderr, /waiting for host load 90\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WERKMEISTER_NO_WAIT=1 runs at once, without wait-load (SW-224)", () => {
  const { root, bin } = wrapper();
  try {
    const env = { ...stubbedPath(root), WERKMEISTER_NO_WAIT: "1" };
    const r = spawnSync(bin, ["true"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(root), "");
    assert.equal(r.stderr, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--no-wait first runs at once, without wait-load, and is not passed on (SW-367)", () => {
  const { root, bin } = wrapper();
  try {
    const env = { ...stubbedPath(root) };
    delete env.WERKMEISTER_NO_WAIT;
    const r = spawnSync(bin, ["--no-wait", "sh", "-c", 'printf "%s" "$0"', "first"], {
      encoding: "utf8",
      env,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(root), "");
    assert.equal(r.stdout, "first");
    const alone = spawnSync(bin, ["--no-wait"], { encoding: "utf8", env });
    assert.equal(alone.status, 2);
    assert.match(
      alone.stderr,
      /usage: with-temp-home \[--no-wait\] \[--clean-home\] \[--cwd <dir>\] <cmd>/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-652: a test command works only from its worktree, and the shell's cwd drifts; a `cd` would lose the allow rule.
test("--cwd <dir> runs the command there, whatever the shell's cwd, after --no-wait too (SW-652)", () => {
  const { root, bin } = wrapper();
  try {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "worktree-")));
    for (const args of [
      ["--cwd", dir],
      ["--no-wait", "--cwd", dir],
    ]) {
      const r = spawnSync(bin, [...args, "sh", "-c", "pwd -P"], {
        encoding: "utf8",
        cwd: os.tmpdir(),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), dir, args.join(" "));
    }
    const gone = spawnSync(bin, ["--cwd", path.join(root, "nope"), "sh", "-c", "echo ran"], {
      encoding: "utf8",
    });
    assert.notEqual(gone.status, 0);
    assert.equal(gone.stdout, "", "a missing --cwd runs nothing");
    const alone = spawnSync(bin, ["--cwd", dir], { encoding: "utf8" });
    assert.equal(alone.status, 2);
    assert.match(
      alone.stderr,
      /usage: with-temp-home \[--no-wait\] \[--clean-home\] \[--cwd <dir>\] <cmd>/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Claude Code session's CLAUDECODE and CLAUDE_CODE_* are dropped, CLAUDE_BIN kept (SW-332)", () => {
  const { root, bin } = wrapper();
  try {
    const env = {
      ...process.env,
      CLAUDECODE: "1",
      CLAUDE_CODE_PLUGIN_DIR_WATCH: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_BIN: "/x/claude",
    };
    const r = spawnSync(bin, ["env"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^CLAUDECODE=|^CLAUDE_CODE_/m);
    assert.match(r.stdout, /^CLAUDE_BIN=\/x\/claude$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no werkmeister on PATH, or a failing wait-load, still runs the command (SW-224)", () => {
  const { root, bin } = wrapper();
  try {
    const { WERKMEISTER_NO_WAIT: _, ...env } = process.env;
    const bare = spawnSync(bin, ["sh", "-c", "exit 4"], { env: { ...env, PATH: "/usr/bin:/bin" } });
    assert.equal(bare.status, 4);
    const failing = spawnSync(bin, ["sh", "-c", "exit 5"], { env: stubbedPath(root, 1) });
    assert.equal(failing.status, 5);
    assert.equal(calls(root), "werkmeister internal wait-load\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a spent host-load wait (wait-load exits 75) stops the wrapper before its command (SW-540)", () => {
  const { root, bin } = wrapper();
  try {
    const r = spawnSync(bin, ["sh", "-c", `echo "cmd" >> "${root}/calls"`], {
      env: stubbedPath(root, 75),
    });
    assert.equal(r.status, 75);
    assert.equal(calls(root), "werkmeister internal wait-load\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-264: a temp HOME isolates files, not the daemon on :3002.
test("WERKMEISTER_HOST defaults to an unreachable host; a caller's value is kept (SW-264)", () => {
  const { root, bin } = wrapper();
  const host = (env) =>
    spawnSync(bin, ["sh", "-c", 'printf %s "$WERKMEISTER_HOST"'], { encoding: "utf8", env }).stdout;
  try {
    const { WERKMEISTER_HOST: _, ...env } = process.env;
    assert.equal(host(env), "http://127.0.0.1:65535");
    assert.equal(host({ ...env, WERKMEISTER_HOST: "http://mine:9" }), "http://mine:9");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-1117: a fresh HOME is a first turbo run, which turns telemetry on and calls out.
test("turbo telemetry is off under the wrapper (SW-1117)", () => {
  const { root, bin } = wrapper();
  try {
    const { TURBO_TELEMETRY_DISABLED: _, ...env } = process.env;
    const r = spawnSync(bin, ["sh", "-c", 'printf %s "$TURBO_TELEMETRY_DISABLED"'], {
      encoding: "utf8",
      env,
    });
    assert.equal(r.stdout, "1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a daemon call under the wrapper raises DaemonUnavailable, never reaching :3002 (SW-264)", () => {
  const { root, bin } = wrapper();
  const client = new URL("../dist/daemon_client.js", import.meta.url).href;
  const script = `import(${JSON.stringify(client)}).then(async (m) => {
    console.log(m.daemonUrl());
    await m.callTool("scheduler", {}, { timeoutMs: 5000 }).then(
      () => console.log("reached"),
      (e) => console.log(e instanceof m.DaemonUnavailable ? e.code : e.message, /ECONNREFUSED/.test(e.message)));
  })`;
  try {
    const { WERKMEISTER_HOST: _, ...env } = process.env;
    const r = spawnSync(bin, ["node", "-e", script], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    // SW-743: refused like a stopped daemon, not fetch's "bad port" for :1, and within the short retry.
    assert.equal(r.stdout, "http://127.0.0.1:65535\nDAEMON_DOWN true\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-456: a "hang" under the wrapper was its host-load wait; killing the wrapper left wait-load polling for up to 10 min.
test("killing the wrapper during its host-load wait stops the wait too (SW-456)", async () => {
  const { root, bin } = wrapper();
  const stub = path.join(root, "stub-bin");
  fs.mkdirSync(stub);
  const pidFile = path.join(root, "wait.pid");
  fs.writeFileSync(
    path.join(stub, "werkmeister"),
    `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`,
    {
      mode: 0o755,
    },
  );
  const { WERKMEISTER_NO_WAIT: _, ...env } = process.env;
  // A killed process its new parent hasn't reaped yet is a zombie: kill(pid, 0) still succeeds on it.
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    return stat.trim() !== "" && !stat.trim().startsWith("Z");
  };
  // SW-507: wall-clock, not a poll count: on a loaded host the spawns took over 5 s (11 s at load 389 on 12 cores). 60 s stays far under the stub's 300 s.
  const until = async (ok) => {
    for (const end = Date.now() + 60_000; !ok() && Date.now() < end; )
      await new Promise((r) => setTimeout(r, 100));
    return ok();
  };
  const child = spawn(bin, ["true"], {
    env: { ...env, PATH: `${stub}:${process.env.PATH}` },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  let waitPid = 0;
  try {
    assert.ok(
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim()),
      "wait started",
    );
    waitPid = Number(fs.readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    await exited;
    assert.ok(
      await until(() => !alive(waitPid)),
      `wait-load ${waitPid} still running after the wrapper was killed`,
    );
  } finally {
    // SW-529: a failed "wait started" leaves the wrapper running; SIGTERM fires its trap, which ends the stub too. No-op once it has exited.
    child.kill("SIGTERM");
    if (waitPid && alive(waitPid)) process.kill(waitPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// SW-935: slim images (python:3.14-slim) have no procps, so `uptime: not found` landed in every gate excerpt.
test("no uptime: the failure line reads /proc/loadavg, or leaves the load out, with no 'not found' (SW-935)", () => {
  const { root, bin } = wrapper();
  try {
    const tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    for (const t of ["sh", "sed", "mktemp", "rm", "env", "getconf", "cat"]) {
      const at = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (at) fs.symlinkSync(at, path.join(tools, t));
    }
    const r = spawnSync(bin, ["sh", "-c", "exit 3"], {
      encoding: "utf8",
      env: { ...process.env, PATH: tools },
    });
    assert.equal(r.status, 3);
    assert.doesNotMatch(r.stderr, /not found/);
    const line = fs.existsSync("/proc/loadavg")
      ? /^with-temp-home: exit 3; host load [\d.]+ [\d.]+ [\d.]+ on \d+ cores$/m
      : /^with-temp-home: exit 3$/m;
    assert.match(r.stderr, line);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-1049: a probe guards itself at load time on this marker, so a run outside the wrapper never reaches the real HOME.
test("WERKMEISTER_TEMP_HOME is the temp HOME itself, whatever the caller exported (SW-1049)", () => {
  const { root, bin } = wrapper();
  try {
    const r = spawnSync(bin, ["sh", "-c", 'printf "%s|%s" "$WERKMEISTER_TEMP_HOME" "$HOME"'], {
      encoding: "utf8",
      env: { ...process.env, WERKMEISTER_TEMP_HOME: "/caller" },
    });
    assert.equal(r.status, 0, r.stderr);
    const [marker, home] = r.stdout.split("|");
    assert.equal(marker, home);
    assert.notEqual(home, process.env.HOME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A zombie answers kill(pid, 0) until init reaps it, so `ps` decides.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return stat.trim() !== "" && !stat.trim().startsWith("Z");
};
// SW-507: wall-clock headroom for a loaded host, far under the command's 300 s.
const until = async (ok) => {
  for (const end = Date.now() + 60_000; !ok() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 100));
  return ok();
};

test("SIGTERM to the wrapper ends its command and what it started, and removes the temp HOME (SW-1149)", async () => {
  const { root, bin } = wrapper();
  // The sleep is the command's own child, as `pnpm build` is under `sh -c 'pnpm build && pnpm test'`.
  const child = spawn(bin, ["sh", "-c", 'sleep 300 & echo "$! $HOME"; wait'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  let cmdPid = 0;
  try {
    assert.ok(await until(() => out.includes("\n")), "command started");
    const [pid, home] = out.trim().split(" ");
    cmdPid = Number(pid);
    assert.ok(fs.existsSync(home));
    child.kill("SIGTERM");
    assert.ok(await until(() => !alive(cmdPid)), `command ${cmdPid} still running`);
    assert.equal(await exited, 143);
    assert.equal(fs.existsSync(home), false, "temp HOME left behind");
  } finally {
    if (cmdPid && alive(cmdPid)) process.kill(cmdPid);
    child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a command that ignores SIGTERM is killed after a grace, and the temp HOME removed (SW-1193)", async () => {
  const { root, bin } = wrapper();
  const child = spawn(bin, ["sh", "-c", 'trap "" TERM; sleep 300 & echo "$! $HOME"; wait'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise((r) => child.on("exit", (code, signal) => r(code ?? signal)));
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  let cmdPid = 0;
  try {
    assert.ok(await until(() => out.includes("\n")), "command started");
    const [pid, home] = out.trim().split(" ");
    cmdPid = Number(pid);
    child.kill("SIGTERM");
    // SW-507: the grace is 5 s; the rest is headroom for a loaded host.
    const code = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r("hung"), 60_000).unref()),
    ]);
    assert.equal(code, 137, "the wrapper should end its TERM-ignoring command with KILL");
    assert.ok(await until(() => !alive(cmdPid)), `command's child ${cmdPid} still running`);
    assert.equal(fs.existsSync(home), false, "temp HOME left behind");
  } finally {
    if (cmdPid && alive(cmdPid)) process.kill(cmdPid, "SIGKILL");
    child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the command still reads the caller's stdin (SW-1149)", () => {
  const { root, bin } = wrapper();
  try {
    const r = spawnSync(bin, ["sh", "-c", 'read l; echo "got:$l"'], {
      input: "hi\n",
      encoding: "utf8",
    });
    assert.equal(r.stdout, "got:hi\n");
    assert.equal(r.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// SW-1177: CI's require-clean-home.sh fails a test that writes the runner's real ~/.werkmeister; the gate's twin.
test("--clean-home fails a passing command that wrote $HOME/.werkmeister, listing it (SW-1177)", () => {
  const { root, bin } = wrapper();
  try {
    const write = 'mkdir -p "$HOME/.werkmeister/metrics" && touch "$HOME/.werkmeister/metrics/x"';
    const r = spawnSync(bin, ["--no-wait", "--clean-home", "sh", "-c", write], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /the command wrote \$HOME\/\.werkmeister/);
    assert.match(r.stderr, /metrics\/x/);
    // The opt-out: without the flag a CLI exercise that writes its temp HOME passes.
    const plain = spawnSync(bin, ["--no-wait", "sh", "-c", write], { encoding: "utf8" });
    assert.equal(plain.status, 0, plain.stderr);
    // A failing command keeps its own status; a clean one passes.
    const failing = 'mkdir "$HOME/.werkmeister"; exit 3';
    const f = spawnSync(bin, ["--no-wait", "--clean-home", "sh", "-c", failing], {
      encoding: "utf8",
    });
    assert.equal(f.status, 3, f.stderr);
    const clean = spawnSync(bin, ["--no-wait", "--clean-home", "--cwd", root, "true"], {
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
