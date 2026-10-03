// `proc.run` is spawnSync and cannot be cancelled, so every long-running core
// path needs this async sibling. The abort contract is what a remote caller
// gets instead of killing the CLI process.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runAsync, ProcError } from "./dist/proc.js";

test("runAsync captures stdout and the exit status", async () => {
  const res = await runAsync(["node", "-e", "process.stdout.write('hi')"], { capture: true });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "hi");
});

test("runAsync rejects with ABORT_ERR promptly when the signal fires", async () => {
  const ac = new AbortController();
  const started = Date.now();
  const promise = runAsync(["node", "-e", "setTimeout(() => {}, 60000)"], {
    capture: true,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50);

  const err = await promise.then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, `expected ProcError, got ${err}`);
  assert.equal(err.code, "ABORT_ERR");
  // Promptness is the contract, not just the verdict: without the signal
  // reaching spawn, this still rejects with ABORT_ERR -- 60s later, once the
  // child exits on its own. The elapsed bound is what catches that.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `abort took ${elapsed}ms; the child was abandoned, not killed`);
});

test("runAsync rejects with ENOENT for a missing executable", async () => {
  const err = await runAsync(["definitely-not-a-real-binary-xyz"], { capture: true })
    .then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, `expected ProcError, got ${err}`);
  assert.equal(err.code, "ENOENT");
});

test("runAsync throws on non-zero status only when check is set", async () => {
  const res = await runAsync(["node", "-e", "process.exit(3)"], { capture: true });
  assert.equal(res.status, 3);

  const err = await runAsync(["node", "-e", "process.exit(3)"], { capture: true, check: true })
    .then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, `expected ProcError, got ${err}`);
  assert.equal(err.status, 3);
});

test("runAsync rejects with ETIMEDOUT, distinct from an abort", async () => {
  const err = await runAsync(["node", "-e", "setTimeout(() => {}, 60000)"], {
    capture: true,
    timeout: 1,
  }).then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, `expected ProcError, got ${err}`);
  assert.equal(err.code, "ETIMEDOUT");
});

test("an aborted child is actually dead, not just abandoned", async () => {
  // The pid travels through a file, not through stdout: runAsync only surfaces
  // stdout once the child is gone, so reading it back would race the abort --
  // and under a loaded machine that race is lost, not merely slow.
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pid-")), "pid");
  const ac = new AbortController();
  const promise = runAsync(
    ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`],
    { capture: true, signal: ac.signal },
  );

  // Poll for the pid, not the file: writeFileSync creates the file before it
  // writes to it, so a loaded machine can see it exist but still empty.
  const readPid = () => Number(fs.readFileSync(pidFile, { encoding: "utf8", flag: "a+" }).trim());
  const deadline = Date.now() + 10000;
  while (!(readPid() > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const pid = readPid();
  assert.ok(Number.isInteger(pid) && pid > 0, "the child never reported a pid");

  const started = Date.now();
  ac.abort();
  await promise.catch(() => {});
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `abort took ${elapsed}ms; the child outlived its abort`);

  // The kill is delivered asynchronously; give the OS a moment to reap it.
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH -- gone, which is the whole assertion
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`pid ${pid} survived the abort`);
});
