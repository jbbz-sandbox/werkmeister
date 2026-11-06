// SW-383: HarnessAdapter is harness-neutral. The interface, the shared turn runner
// and the stub adapter import nothing from harness/claude, and runTurn carries the
// detach / grace-period / registry behaviour startTurn used to own.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { stubAdapter } from "./dist/harness/stub/index.js";
import { runTurn, turnEvents, turnStatus } from "./dist/harness/turn.js";

const IDLE = { state: "idle", startedAt: null, exitCode: null, error: null };
const src = (f) => fs.readFileSync(path.join(import.meta.dirname, "src", "harness", f), "utf-8");

test("the neutral modules and the opencode adapter import nothing from harness/claude", () => {
  for (const f of [
    "types.ts",
    "turn.ts",
    "sessions.ts",
    "stub/index.ts",
    "opencode/index.ts",
    "opencode/layout.ts",
    "opencode/hooks.ts",
    "opencode/session.ts",
    "opencode/transcript.ts",
  ]) {
    assert.doesNotMatch(src(f), /from\s+["'][^"']*claude/, f);
  }
});

// SW-384: Codex borrows only Claude's pure helpers: the JSON/tag extractors and the usage roll-up.
test("the Codex session modules import from harness/claude only its pure helpers", () => {
  const allowed = new Set(["../claude/cli.js", "../claude/usage.js"]);
  for (const f of ["cli.ts", "session.ts", "transcript.ts", "usage.ts", "adapter.ts"]) {
    for (const [, spec] of src(`codex/${f}`).matchAll(/from\s+["']([^"']*claude[^"']*)["']/g))
      assert.ok(allowed.has(spec), `${f} imports ${spec}`);
  }
});

test("codexAdapter has every key stubAdapter has", async () => {
  const { codexAdapter } = await import("./dist/harness/codex/adapter.js");
  assert.equal(codexAdapter.id, "codex");
  assert.deepEqual(Object.keys(codexAdapter).sort(), Object.keys(stubAdapter).sort());
});

test("stub adapter conforms and is inert", async () => {
  assert.equal(stubAdapter.id, "mcp");
  assert.deepEqual(stubAdapter.turnStatus("x"), IDLE);
  await assert.rejects(stubAdapter.sendTurn("k", "/", "hi", null, null), /not supported/);
});

test("runTurn with wait returns stdout and records done", async () => {
  const events = [];
  turnEvents.on("ok", (e) => events.push(e.state));
  const out = await runTurn(
    "ok",
    process.execPath,
    ["-e", "process.stdout.write('{\"permission_denials\":[]}')"],
    os.tmpdir(),
    true,
  );
  assert.equal(out, '{"permission_denials":[]}');
  const status = turnStatus("ok");
  assert.equal(status.state, "done");
  assert.equal(status.exitCode, 0);
  assert.equal(status.error, null);
  assert.ok(!Number.isNaN(Date.parse(status.startedAt)));
  assert.deepEqual(events, ["running", "done"]);
});

test("runTurn surfaces an immediate non-zero exit as a start failure", async () => {
  await assert.rejects(
    runTurn(
      "bad",
      process.execPath,
      ["-e", "console.error('boom'); process.exit(3)"],
      os.tmpdir(),
      true,
    ),
    /Could not start the turn — node exited with code 3: boom/,
  );
  const status = turnStatus("bad");
  assert.equal(status.state, "failed");
  assert.equal(status.exitCode, 3);
  assert.deepEqual(turnStatus("never"), IDLE);
});
