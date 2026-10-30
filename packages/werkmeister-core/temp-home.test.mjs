// SW-124: the generated wrapper runs a command with a fresh temporary HOME and
// removes it on exit, so no test reaches the real ~/.werkmeister.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { tempHomeWrapper, writeTempHomeWrapper } from "./dist/temp_home.js";

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
