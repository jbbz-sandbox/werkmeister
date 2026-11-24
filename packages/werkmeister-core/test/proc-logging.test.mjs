// SW-404: a failed external call is logged with its exit code, stderr tail and the bound workspace, from every runner.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { createLogger, withLogger, workspaceLogPath } from "../dist/logger.js";
import { run, runAsync } from "../dist/proc.js";
import { runCapture } from "../dist/tool_bins.js";

/** A workspace folder: a log line goes only into a `.werkmeister/` that exists. */
const tmpWs = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sw404-proc-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  return ws;
};

const FAIL = ["sh", "-c", "echo boom >&2; exit 3"];

async function failedCallLine(call) {
  const ws = tmpWs();
  const log = createLogger(
    { app: "cli", workspace: "w", pid: 1 },
    { workspaceDir: ws, level: "warn", stderr: false },
  );
  await withLogger(log, async () => {
    await call().catch(() => {});
  });
  const lines = fs
    .readFileSync(workspaceLogPath(ws), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return lines.find((l) => l.msg === "external call failed");
}

for (const [name, call] of [
  ["run", async () => run(FAIL, { capture: true })],
  ["runAsync", () => runAsync(FAIL, { capture: true })],
  ["runCapture", () => runCapture(FAIL[0], FAIL.slice(1))],
]) {
  test(`${name}: a non-zero exit logs warn with bin, code, stderr tail and the workspace`, async () => {
    const line = await failedCallLine(call);
    assert.ok(line, "logged");
    assert.equal(line.level, "warn");
    assert.equal(line.bin, "sh");
    assert.equal(line.code, 3);
    assert.match(line.stderrTail, /boom/);
    assert.equal(line.workspace, "w");
  });
}

test("a zero exit logs nothing", async () => {
  const ws = tmpWs();
  const log = createLogger({ pid: 1 }, { workspaceDir: ws, level: "trace", stderr: false });
  await withLogger(log, async () => run(["sh", "-c", "exit 0"], { capture: true }));
  assert.equal(fs.existsSync(workspaceLogPath(ws)), false);
});
