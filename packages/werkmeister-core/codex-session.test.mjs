// SW-384: Codex turns go through the shared runner as `codex exec [resume <id>]`,
// and the resume command reopens a session with the workspace token.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { codexSendArgs, codexStartTurn, codexResumeCommand } = await import(
  "./dist/harness/codex/session.js"
);
const { turnStatus } = await import("./dist/harness/turn.js");

test("send args: new and resumed turns both pin the workspace-write sandbox", () => {
  assert.deepEqual(codexSendArgs("hi", null, null), [
    "exec",
    "--skip-git-repo-check",
    "-c",
    'sandbox_mode="workspace-write"',
    "--",
    "hi",
  ]);
  assert.deepEqual(codexSendArgs("hi", "abc-1", "gpt-6", true), [
    "exec",
    "resume",
    "abc-1",
    "--skip-git-repo-check",
    "--json",
    "-m",
    "gpt-6",
    "-c",
    'sandbox_mode="workspace-write"',
    "--",
    "hi",
  ]);
});

test("sendTurn with wait resumes by id in cwd through runTurn", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-")));
  const bin = path.join(dir, "codex");
  const log = path.join(dir, "log.json");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write('{"type":"turn.completed"}\\n');
`,
    { mode: 0o755 },
  );
  process.env.WERKMEISTER_FIXTURE = "1";
  process.env.CODEX_BIN = bin;
  try {
    const res = await codexStartTurn("codex-key", dir, "do it", "sess-9", null, { wait: true });
    assert.deepEqual(res, { denied: [] });
  } finally {
    delete process.env.CODEX_BIN;
  }
  const { argv, cwd } = JSON.parse(fs.readFileSync(log, "utf-8"));
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "sess-9"]);
  assert.equal(argv.at(-1), "do it");
  assert.equal(cwd, dir);
  assert.equal(turnStatus("codex-key").state, "done");
});

test("resume command: token prefix, resume <id>, model after the subcommand, quoted prompt", () => {
  const launch = "WERKMEISTER_MCP_TOKEN=$(cat .werkmeister/token) codex";
  assert.equal(codexResumeCommand(null, null), launch);
  assert.equal(codexResumeCommand("abc", null), `${launch} resume 'abc'`);
  assert.equal(codexResumeCommand("x; id", null), `${launch} resume 'x; id'`);
  assert.equal(
    codexResumeCommand("abc", "gpt-6", "it's"),
    `${launch} resume -m 'gpt-6' 'abc' 'it'\\''s'`,
  );
  assert.equal(codexResumeCommand(null, "gpt-6"), `${launch} -m 'gpt-6'`);
});
