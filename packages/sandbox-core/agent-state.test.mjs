// SW-46: a workspace's agent state — working / needs-you / done / idle — from the
// state file Claude Code hooks write, else from the transcript tail.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-state-home-"));
const root = path.join(home, "features");
process.env.HOME = home;
process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";
process.env.SANDBOX_WORKSPACES_ROOT = root;

const { getWorkspaceStatuses } = await import("./dist/sandbox.js");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A workspace whose newest transcript ends with `role` saying `text`, `ageMs` ago. */
function workspace(name, last, ageMs = 0) {
  const dir = path.join(root, name);
  write(path.join(dir, ".werkmeister", "workspace.yml"), "autonomous: false\n");
  if (!last) return dir;
  const [role, text] = last;
  const project = path.join(home, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  const file = path.join(project, "s1.jsonl");
  write(file, `${JSON.stringify({ type: role, message: { role, content: text } })}\n`);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return dir;
}

const byName = async () =>
  Object.fromEntries((await getWorkspaceStatuses()).statuses.map((s) => [s.name, s.claude]));

test("no state file: the transcript tail tells done, needs-you, working and idle apart", async () => {
  workspace("a-done", ["assistant", "Shipped: PR #12 is open and the gate passed."]);
  workspace("b-asks", ["assistant", "Two ways to fix this. Which do you want?"]);
  workspace("c-live", ["user", "go"]);
  workspace("d-stale", ["user", "go"], 3 * 60 * 60 * 1000);
  workspace("e-none", null);
  const c = await byName();
  assert.equal(c["a-done"].agent, "done", "a finished run is not waiting on you");
  assert.equal(c["b-asks"].agent, "needs-you");
  assert.equal(c["c-live"].agent, "working");
  assert.equal(c["d-stale"].agent, "idle", "a turn nobody has touched in hours is not live");
  assert.equal(c["e-none"].agent, "idle");
  assert.equal("waiting" in c["a-done"], false, "agent replaces claude.waiting");
});

test("the hooks' state file wins over the transcript tail", async () => {
  const dir = workspace("f-file", ["assistant", "Shipped."]);
  const at = "2026-10-19T12:00:00.000Z";
  write(
    path.join(dir, ".werkmeister", "agent-state.json"),
    JSON.stringify({
      state: "needs-you",
      at,
      question: "Claude needs your permission to use Bash",
    }),
  );
  const c = (await byName())["f-file"];
  assert.equal(c.agent, "needs-you");
  assert.equal(c.at, at);
  assert.equal(c.question, "Claude needs your permission to use Bash");
});

test("an unreadable state file falls back to the transcript", async () => {
  const dir = workspace("g-junk", ["assistant", "Shipped."]);
  write(path.join(dir, ".werkmeister", "agent-state.json"), "{not json");
  assert.equal((await byName())["g-junk"].agent, "done");
});

const { record, readAgentState } = await import("./dist/agent_state.js");

test("hooks: each event writes the state the pane shows, `at` only when it changes", () => {
  const dir = workspace("h-hooks", null);
  const cwd = path.join(dir, "sandbox", "packages");
  fs.mkdirSync(cwd, { recursive: true });
  const fire = (event, extra = {}, now = new Date()) =>
    record({ hook_event_name: event, cwd, ...extra }, now);
  const t0 = new Date("2026-10-19T10:00:00Z");

  fire("UserPromptSubmit", {}, t0);
  assert.deepEqual(readAgentState(dir), { state: "working", at: t0.toISOString() });
  assert.equal(fire("PreToolUse", { tool_name: "Bash" }), null, "still working: no rewrite");
  assert.equal(readAgentState(dir).at, t0.toISOString());

  fire("Notification", {
    notification_type: "permission_prompt",
    message: "Claude needs your permission to use Bash",
  });
  assert.equal(readAgentState(dir).state, "needs-you");
  assert.equal(readAgentState(dir).question, "Claude needs your permission to use Bash");
  fire("PostToolUse", { tool_name: "Bash" });
  assert.equal(readAgentState(dir).state, "working", "approved: back to work");

  fire("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which fix?" }] },
  });
  assert.deepEqual(
    [readAgentState(dir).state, readAgentState(dir).question],
    ["needs-you", "Which fix?"],
  );

  const transcript = path.join(dir, "t.jsonl");
  const say = (text) =>
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } })}\n` +
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n` +
        `${JSON.stringify({ type: "system", subtype: "stop_hook_summary" })}\n`,
    );
  say("Fixed it.\n\nShould I open the PR now?");
  fire("Stop", { transcript_path: transcript });
  assert.deepEqual(
    [readAgentState(dir).state, readAgentState(dir).question],
    ["needs-you", "Should I open the PR now?"],
  );
  say("Shipped: PR #12 is open.");
  fire("Stop", { transcript_path: transcript });
  assert.deepEqual(readAgentState(dir).state, "done");
  fire("Stop", { last_assistant_message: "Which one do **you** want?**" });
  assert.equal(readAgentState(dir).state, "needs-you", "last_assistant_message wins when sent");

  fire("Stop", { last_assistant_message: "Done." });
  fire("Notification", {
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  });
  fire("Notification", { message: "Claude is waiting for your input" });
  assert.equal(readAgentState(dir).state, "done", "the idle reminder after Stop is not a question");
  fire("SessionEnd", { reason: "exit" });
  assert.equal(
    readAgentState(dir).state,
    "done",
    "a finished run stays done after its session closes",
  );
  fire("UserPromptSubmit");
  fire("SessionEnd", { reason: "exit" });
  assert.equal(readAgentState(dir).state, "idle", "a turn cut off by the exit is not live");
});

test("hooks: outside a workspace, or on junk input, nothing is written", () => {
  assert.equal(record({ hook_event_name: "Stop", cwd: os.tmpdir() }), null);
  const dir = workspace("i-junk", null);
  assert.equal(record({ hook_event_name: "SubagentStop", cwd: dir }), null);
  assert.equal(readAgentState(dir), null);
});
