import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { spawnCapture } from "./dist/sandbox.js";

test("forwards stdout+stderr chunks and returns combined output + code", async () => {
  const chunks = [];
  const res = await spawnCapture(
    execPath,
    ["-e", "process.stdout.write('out');process.stderr.write('err')"],
    { onData: (c) => chunks.push(c) },
  );
  assert.equal(res.stdout, "out");
  assert.equal(res.stderr, "err");
  assert.equal(res.code, 0);
  assert.equal(chunks.join(""), "outerr"); // both streams reached onData
});

test("non-zero exit resolves (does not reject) with code", async () => {
  const res = await spawnCapture(execPath, ["-e", "process.exit(3)"]);
  assert.equal(res.code, 3);
});

test("works with no onData (pure capture)", async () => {
  const res = await spawnCapture(execPath, ["-e", "process.stdout.write('hi')"]);
  assert.equal(res.stdout, "hi");
});
