// SW-1196: `_run` and `runAsyncRunner` share one contract: [returncode, combined output], 127 for
// a missing binary, 124 for a timeout, and every other error (an abort above all) rethrown. Each
// case runs against both runners so the two cannot drift. Plain commands only, never
// `telepresence`, so the SW-1153 test guard passes them through untouched.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { _run, runAsyncRunner } from "../dist/telepresence.js";

const RUNNERS = {
  _run: async (cmd, timeout) => _run(cmd, timeout),
  runAsyncRunner: (cmd, timeout) => runAsyncRunner(cmd, undefined, timeout),
};

for (const [name, runner] of Object.entries(RUNNERS)) {
  test(`${name}: a missing binary is 127 and names the command`, async () => {
    assert.deepEqual(await runner(["sw1196-no-such-bin", "x"]), [
      127,
      "sw1196-no-such-bin: command not found",
    ]);
  });

  test(`${name}: a timeout is 124 and names the command and the timeout`, async () => {
    assert.deepEqual(await runner(["sleep", "5"], 0.2), [124, "sleep 5: timed out after 0.2s"]);
  });

  test(`${name}: stdout and stderr are combined and trimmed, with the exit status`, async () => {
    assert.deepEqual(await runner(["sh", "-c", "echo out; echo err >&2; exit 3"]), [3, "out\nerr"]);
  });

  test(`${name}: any other spawn failure is rethrown`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw1196-"));
    const file = path.join(dir, "not-executable");
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o644 });
    try {
      await assert.rejects(async () => runner([file]), { name: "ProcError", code: "EACCES" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("runAsyncRunner: an abort is rethrown, not flattened into a returncode", async () => {
  const ac = new AbortController();
  const pending = runAsyncRunner(["sleep", "5"], ac.signal, 30);
  ac.abort();
  await assert.rejects(pending, { name: "ProcError", code: "ABORT_ERR" });
});
