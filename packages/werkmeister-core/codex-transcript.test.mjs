// SW-384: the Codex session store reader, against fixture rollouts under $CODEX_HOME:
// which sessions a workspace owns, the transcript rows, the signal and the usage.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeSessionState } from "./fixtures.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-store-")));
process.env.CODEX_HOME = path.join(root, "codex");
// A temp HOME, so the usage test never prices from the real ~/.werkmeister/model-pricing.yaml.
process.env.HOME = path.join(root, "home");
const ws = path.join(root, "ws");
fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });

const { codexAdapter } = await import("./dist/harness/codex/adapter.js");

const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "05");
fs.mkdirSync(day, { recursive: true });
const line = (type, payload, timestamp = "2026-11-05T10:00:00.000Z") =>
  JSON.stringify({ timestamp, type, payload });
const msg = (role, text) =>
  line("response_item", {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });

function rollout(id, cwd, lines, mtime) {
  const file = path.join(day, `rollout-2026-11-05T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, [line("session_meta", { id, cwd }), ...lines].join("\n") + "\n");
  fs.utimesSync(file, mtime, mtime);
  return file;
}

const older = rollout("old-1", ws, [msg("user", "first ask")], new Date("2026-11-05T09:00:00Z"));
const newest = rollout(
  "new-2",
  ws,
  [
    msg("user", "# AGENTS.md instructions for /ws\n\n<INSTRUCTIONS>…"),
    msg("developer", "you are codex"),
    line("turn_context", { model: "gpt-6", cwd: ws }),
    msg("user", "fix the bug"),
    line("response_item", { type: "custom_tool_call", name: "exec", input: "const r=1;\nmore" }),
    line("response_item", { type: "function_call_output", output: "x" }),
    msg("assistant", "Done. Shall I open the PR?"),
    line("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 600,
          cache_write_input_tokens: 0,
          output_tokens: 50,
        },
      },
    }),
    "{not json",
  ],
  new Date("2026-11-05T10:00:00Z"),
);
rollout("elsewhere-3", "/somewhere/else", [msg("user", "not ours")], new Date());
rollout("sibling-4", `${ws}-other`, [msg("user", "a sibling folder")], new Date());
rollout(
  "worktree-5",
  path.join(ws, "repo"),
  [msg("user", "in the worktree")],
  new Date("2026-11-05T08:00:00Z"),
);

test("listSessions holds only this workspace's rollouts, newest first, titled", async () => {
  const list = await codexAdapter.listSessions(ws);
  assert.deepEqual(
    list.map((s) => [s.sessionId, s.title, s.isNewest]),
    [
      ["new-2", "fix the bug", true],
      ["old-1", "first ask", false],
      ["worktree-5", "in the worktree", false],
    ],
  );
});

test("transcript: injected context and developer lines skipped, tool row compact", async () => {
  const t = await codexAdapter.transcript(ws);
  assert.equal(t.sessionId, "new-2");
  assert.equal(t.sessionCount, 3);
  assert.deepEqual(
    t.messages.map((m) => [m.role, m.text]),
    [
      ["user", "fix the bug"],
      ["tool", "exec: const r=1;"],
      ["assistant", "Done. Shall I open the PR?"],
    ],
  );
  // The window keeps the tool rows that sit inside it.
  assert.deepEqual(
    (await codexAdapter.transcript(ws, 1)).messages.map((m) => m.role),
    ["tool", "assistant"],
  );
  assert.equal((await codexAdapter.transcript(ws, 20, "old-1")).messages[0].text, "first ask");
  assert.equal((await codexAdapter.transcript(ws, 20, "gone")).sessionId, "new-2");
});

test("sessionSource points at the newest rollout and its day folder", async () => {
  const src = await codexAdapter.sessionSource(ws);
  assert.equal(src.sessionFile, newest);
  assert.equal(src.projectDir, day);
  assert.equal((await codexAdapter.sessionSource(ws, "old-1")).sessionFile, older);
  const none = await codexAdapter.sessionSource(path.join(root, "empty"));
  assert.equal(none.sessionFile, null);
  assert.equal(none.sessionCount, 0);
});

test("parseSession gives the transcript's rows", () => {
  const rows = codexAdapter.parseSession(fs.readFileSync(newest, "utf-8"));
  assert.equal(rows.length, 3);
});

test("agentSignal: hooks' state wins, else the tail decides", async () => {
  const src = { sessionFile: newest, updatedAt: new Date().toISOString() };
  const tail = await codexAdapter.agentSignal("k-tail", ws, src);
  assert.equal(tail.signal.agent, "needs-you");
  assert.equal(tail.signal.question, "Done. Shall I open the PR?");

  const state = path.join(ws, ".werkmeister", "sessions");
  writeSessionState(ws, "working");
  try {
    assert.equal((await codexAdapter.agentSignal("k-tail", ws, src)).signal.agent, "working");
  } finally {
    fs.rmSync(state, { recursive: true });
  }
  assert.equal((await codexAdapter.agentSignal("k-none", ws, null)).signal.agent, "idle");

  const tailOf = async (lines) => {
    const file = path.join(root, "tail.jsonl");
    fs.writeFileSync(file, lines.join("\n"));
    return (
      await codexAdapter.agentSignal("k-x", ws, { sessionFile: file, updatedAt: src.updatedAt })
    ).signal.agent;
  };
  assert.equal(await tailOf([msg("assistant", "Done.")]), "done");
  assert.equal(
    await tailOf([line("response_item", { type: "function_call", name: "wait", arguments: "{}" })]),
    "working",
  );
});

test("usage: the last token_count, cached input split out, unpriced model has no USD", async () => {
  const u = await codexAdapter.usage("ws", ws);
  assert.deepEqual(u.totals, { input: 400, output: 50, cacheCreation: 0, cacheRead: 600 });
  assert.deepEqual(
    u.byModel.map((m) => [m.model, m.estUsd]),
    [["gpt-6", null]],
  );
  assert.deepEqual(
    u.sessions.map((s) => s.sessionId),
    ["new-2"],
  );
});
