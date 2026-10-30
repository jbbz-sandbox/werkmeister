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
    assert.equal(calls(root), "werkmeister wait-load\ncmd\n");
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
    assert.equal(calls(root), "werkmeister wait-load\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
