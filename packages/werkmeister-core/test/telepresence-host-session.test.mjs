// SW-1074: the telepresence daemon runs once per user, whatever HOME is. A with-temp-home
// or fixture run must not connect, intercept or leave through it, or it could switch the
// namespace (or end the intercepts) other workspaces depend on.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  ensureConnected,
  leaveIntercept,
  listIntercepts,
  startIntercept,
} from "../dist/telepresence.js";
import { withSandboxHome } from "./fixtures.mjs";

/** Run *fn* with a `telepresence` on PATH that logs each call; returns the logged lines. */
async function withStubTelepresence(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-stub-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "telepresence"), `#!/bin/sh\necho "$*" >> "${log}"\n`, {
    mode: 0o755,
  });
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
  try {
    await fn();
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const args = { feature: "demo", service: "backend", localServices: ["backend"] };
// Interceptable, so start and leave reach the daemon when nothing skips them.
const home = {
  services:
    "services:\n  backend:\n    type: api\n    repo: demo-repo\n    port_offset: 2\n" +
    "    k8s_namespace: dev\n    k8s_deployment: backend\n    k8s_port: 80\n    k8s_port_name: http\n",
};

/** Every daemon-reaching entry point; the rejections are the skip, not the daemon's answer. */
async function driveEveryPath() {
  const state = await listIntercepts();
  await ensureConnected("ctx", "dev");
  const started = await startIntercept(args).then(
    () => null,
    (e) => e,
  );
  const left = await leaveIntercept(args).then(
    () => null,
    (e) => e,
  );
  return { state, started, left };
}

for (const [name, reason, set] of [
  [
    "a with-temp-home HOME",
    "a with-temp-home HOME",
    (env) => (env.WERKMEISTER_TEMP_HOME = env.HOME),
  ],
  ["WERKMEISTER_FIXTURE", "WERKMEISTER_FIXTURE", (env) => (env.WERKMEISTER_FIXTURE = "1")],
]) {
  test(`under ${name}, no telepresence call reaches the user's daemon (SW-1074)`, async () => {
    await withSandboxHome(async () => {
      const prev = [process.env.WERKMEISTER_TEMP_HOME, process.env.WERKMEISTER_FIXTURE];
      delete process.env.WERKMEISTER_TEMP_HOME;
      delete process.env.WERKMEISTER_FIXTURE;
      set(process.env);
      try {
        let r;
        const calls = await withStubTelepresence(async () => {
          r = await driveEveryPath();
        });
        assert.deepEqual(calls, []);
        assert.equal(r.state.installed, false);
        for (const err of [r.started, r.left]) {
          assert.equal(err?.code, "HOST_SESSION");
          assert.match(err.message, new RegExp(reason));
        }
      } finally {
        for (const [k, v] of [
          ["WERKMEISTER_TEMP_HOME", prev[0]],
          ["WERKMEISTER_FIXTURE", prev[1]],
        ]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }, home);
  });
}

test("with HOME moved off the with-temp-home marker, the stub is reached: the test can fail (SW-1074)", async () => {
  await withSandboxHome(async () => {
    const prev = [process.env.WERKMEISTER_TEMP_HOME, process.env.WERKMEISTER_FIXTURE];
    delete process.env.WERKMEISTER_FIXTURE;
    process.env.WERKMEISTER_TEMP_HOME = path.join(process.env.HOME, "elsewhere");
    try {
      const calls = await withStubTelepresence(driveEveryPath);
      assert.ok(
        calls.some((c) => c.startsWith("status")),
        calls.join("; "),
      );
      assert.ok(
        calls.some((c) => c.startsWith("detach")),
        calls.join("; "),
      );
    } finally {
      if (prev[0] === undefined) delete process.env.WERKMEISTER_TEMP_HOME;
      else process.env.WERKMEISTER_TEMP_HOME = prev[0];
      if (prev[1] !== undefined) process.env.WERKMEISTER_FIXTURE = prev[1];
    }
  }, home);
});
