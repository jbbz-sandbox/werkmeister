// SW-124: the generated wrapper runs a command with a fresh temporary HOME and
// removes it on exit, so no test reaches the real ~/.werkmeister.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { tempHomeWrapper, writeTempHomeWrapper } from "./dist/temp_home.js";

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

// SW-264: a temp HOME isolates files, not the daemon on :3002.
test("WERKMEISTER_HOST defaults to an unreachable host; a caller's value is kept (SW-264)", () => {
  const { root, bin } = wrapper();
  const host = (env) =>
    spawnSync(bin, ["sh", "-c", 'printf %s "$WERKMEISTER_HOST"'], { encoding: "utf8", env }).stdout;
  try {
    const { WERKMEISTER_HOST: _, ...env } = process.env;
    assert.equal(host(env), "http://127.0.0.1:1");
    assert.equal(host({ ...env, WERKMEISTER_HOST: "http://mine:9" }), "http://mine:9");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a daemon call under the wrapper raises DaemonUnavailable, never reaching :3002 (SW-264)", () => {
  const { root, bin } = wrapper();
  const client = new URL("./dist/daemon_client.js", import.meta.url).href;
  const script = `import(${JSON.stringify(client)}).then(async (m) => {
    console.log(m.daemonUrl());
    await m.callTool("scheduler", {}, { timeoutMs: 5000 }).then(
      () => console.log("reached"),
      (e) => console.log(e instanceof m.DaemonUnavailable ? e.code : e.message));
  })`;
  try {
    const { WERKMEISTER_HOST: _, ...env } = process.env;
    const r = spawnSync(bin, ["node", "-e", script], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "http://127.0.0.1:1\nDAEMON_DOWN\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
