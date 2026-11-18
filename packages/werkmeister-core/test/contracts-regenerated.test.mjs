// SW-760: a `workspace init` rerun commits the regenerated contracts on their own and nudges a live session.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { readNudge } from "../dist/agent_state.js";
import { CONTRACTS_CHANGED_NUDGE, recordRegeneratedContracts } from "../dist/workspace_init.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
Object.assign(process.env, env);
const git = (ws, ...args) => execFileSync("git", ["-C", ws, ...args], { env, encoding: "utf8" });
const ICM_OWNED = ["CLAUDE.md", "AGENTS.md", "CONTEXT.md", "BRIEF.md", "_shared", "stages"];
const FILES = [
  "CLAUDE.md",
  "_shared/pr-rules.md",
  "stages/01_x/CONTEXT.md",
  "stages/01_x/output/repro.md",
];

function workspace(sessions) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "contracts-"));
  git(ws, "init", "-q");
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), "old\n");
  }
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  for (const f of FILES) fs.writeFileSync(path.join(ws, f), "new\n");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  if (sessions)
    fs.writeFileSync(
      path.join(ws, ".werkmeister", "agent-state.json"),
      JSON.stringify({ sessions }),
    );
  return ws;
}

test("SW-760: regenerated contracts are committed alone; stage outputs stay the agent's", () => {
  const ws = workspace();
  assert.equal(recordRegeneratedContracts(ws, ICM_OWNED), true);
  assert.equal(git(ws, "log", "-1", "--format=%s"), "chore: regenerate workspace contracts\n");
  assert.deepEqual(git(ws, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [
    "CLAUDE.md",
    "_shared/pr-rules.md",
    "stages/01_x/CONTEXT.md",
  ]);
  assert.equal(git(ws, "status", "--porcelain").trim(), "M stages/01_x/output/repro.md");
  assert.equal(readNudge(ws), null, "no live session, no nudge");
  assert.equal(recordRegeneratedContracts(ws, ICM_OWNED), false, "nothing new to commit");
});

test("SW-760: a live session gets the nudge", () => {
  const ws = workspace({ s1: { status: "busy", at: new Date().toISOString() } });
  assert.equal(recordRegeneratedContracts(ws, ICM_OWNED), true);
  assert.equal(readNudge(ws), CONTRACTS_CHANGED_NUDGE);
});
