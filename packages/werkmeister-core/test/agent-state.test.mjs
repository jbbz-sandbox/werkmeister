// SW-46: a workspace's agent state — working / needs-you / done / idle — from the
// session records Claude Code hooks write (one file per session since SW-487), else from the transcript tail.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-state-home-"));
const root = path.join(home, "features");
process.env.HOME = home;
// Missing, so config is all defaults; under the temp home so ask/answer metrics land there (SW-776),
// and not the default path, which would turn off sharedProxySkipReason's guard.
process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "w9r", "config.yaml");
process.env.WERKMEISTER_WORKSPACES_ROOT = root;
// The waiting gate asks Docker before it holds a command (SW-986): never the real daemon here.
process.env.WERKMEISTER_DOCKER_BIN = "/nonexistent/docker";

const { getWorkspaceStatuses } = await import("../dist/sandbox.js");

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
  Object.fromEntries(
    (await getWorkspaceStatuses()).statuses.map(({ name, workspaceState: st }) => [
      name,
      // The card's agent word and its first need, where `claude.agent` used to carry them (SW-558).
      { agent: st.agent.id, at: st.agent.since, question: st.needs[0]?.what ?? null },
    ]),
  );

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
});

test("the hooks' session record wins over the transcript tail", async () => {
  const dir = workspace("f-file", ["assistant", "Shipped."]);
  const at = "2026-10-19T12:00:00.000Z";
  const ask = {
    kind: "permission",
    what: "Claude needs your permission to use Bash",
    at,
    source: "session",
  };
  write(
    path.join(dir, ".werkmeister", "sessions", "s1.json"),
    JSON.stringify({ status: "busy", at, last: at, ask }),
  );
  const c = (await byName())["f-file"];
  assert.equal(c.agent, "needs-you");
  assert.equal(c.at, at);
  assert.equal(c.question, "Claude needs your permission to use Bash");
});

test("an unreadable session record falls back to the transcript", async () => {
  const dir = workspace("g-junk", ["assistant", "Shipped."]);
  write(path.join(dir, ".werkmeister", "sessions", "s1.json"), "{not json");
  assert.equal((await byName())["g-junk"].agent, "done");
});

const { record, readSessions, agentOf, asksQuestion, nextSession } = await import(
  "../dist/agent_state.js"
);
/** One session's record and the workspace badge, after its hooks. */
const rec = (dir, id = "s") => readSessions(dir)[id];
const badge = (dir) => agentOf(readSessions(dir));

test("hooks: each event writes the session's state, `at` only when its status changes", () => {
  const dir = workspace("h-hooks", null);
  const cwd = path.join(dir, "sandbox", "packages");
  fs.mkdirSync(cwd, { recursive: true });
  const fire = (event, extra = {}, now = new Date()) =>
    record({ hook_event_name: event, cwd, session_id: "s", ...extra }, now);
  // Recent: SW-559 drops a busy record silent past STALE_SESSION_MS.
  const t0 = new Date(Date.now() - 60_000);

  fire("UserPromptSubmit", {}, t0);
  assert.deepEqual(rec(dir), { status: "busy", at: t0.toISOString(), last: t0.toISOString() });
  fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "pnpm test" } });
  assert.equal(rec(dir).at, t0.toISOString(), "still busy: `at` holds");
  assert.deepEqual([rec(dir).tool.name, rec(dir).tool.command], ["Bash", "pnpm test"]);

  fire("Notification", {
    notification_type: "permission_prompt",
    message: "Claude needs your permission to use Bash",
  });
  assert.deepEqual(
    [rec(dir).ask.kind, rec(dir).ask.what, rec(dir).ask.source],
    ["permission", "Claude needs your permission to use Bash", "session"],
  );
  fire("PostToolUse", { tool_name: "Bash" });
  assert.equal(rec(dir).ask, undefined, "approved: back to work");
  assert.equal(rec(dir).tool, undefined);

  fire("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which fix?" }] },
  });
  assert.deepEqual([badge(dir).agent, badge(dir).question], ["needs-you", "Which fix?"]);
  fire("PostToolUse", { tool_name: "AskUserQuestion" });
  fire("PreToolUse", { tool_name: "ExitPlanMode" });
  assert.equal(rec(dir).ask.kind, "plan");
  fire("PostToolUse", { tool_name: "ExitPlanMode" });

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
    [rec(dir).status, rec(dir).ask.what, rec(dir).ask.source],
    ["idle", "Should I open the PR now?", "text"],
    "a guessed question is marked as a guess",
  );
  say("Shipped: PR #12 is open.");
  fire("Stop", { transcript_path: transcript });
  assert.equal(badge(dir).agent, "done");
  fire("Stop", { last_assistant_message: "Which one do **you** want?**" });
  assert.equal(badge(dir).agent, "needs-you", "last_assistant_message wins when sent");

  fire("Stop", { last_assistant_message: "Done." });
  fire("Notification", {
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  });
  fire("Notification", { message: "Claude is waiting for your input" });
  assert.equal(badge(dir).agent, "done", "the idle reminder after Stop is not a question");
  fire("SessionEnd", { reason: "exit" });
  assert.equal(rec(dir), undefined, "a closed session leaves no record");
});

// SW-487 fault 1: the trailing-`?` test read "Want X? Say so." as done.
test("asksQuestion: a question sentence anywhere in the last paragraph asks", () => {
  assert.equal(asksQuestion("Want me to open the PR? Say so."), true);
  assert.equal(asksQuestion("Which one do **you** want?**"), true);
  assert.equal(asksQuestion("Done.\n\nPR #12 is open."), false);
  assert.equal(asksQuestion("Any questions? None.\n\nShipped."), false, "only the last paragraph");
  // Accepted miss: a rhetorical closing question still reads as one; the card marks it a guess.
  assert.equal(asksQuestion("Who knew it was the cache all along?"), true);
});

test("hooks: a Desktop wrap_up ask is needs-you even when the closing message asks nothing", () => {
  const dir = workspace("h-wrap-up", null);
  const fire = (event, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id: "s", ...extra });
  const wrapUp = (input) => {
    fire("PreToolUse", { tool_name: "mcp__ccd_turn__wrap_up", tool_input: input });
    fire("PostToolUse", { tool_name: "mcp__ccd_turn__wrap_up", tool_input: input });
    fire("Stop", {
      last_assistant_message: "Research is finished: decisions.md has 8 open items.",
    });
  };

  fire("UserPromptSubmit");
  wrapUp({ recap: "Research is written.", ask: "Is the spec approved for 03_implement?" });
  assert.deepEqual(
    [badge(dir).agent, badge(dir).question],
    ["needs-you", "Is the spec approved for 03_implement?"],
  );

  fire("UserPromptSubmit");
  wrapUp({ recap: "PR #12 is open." });
  assert.equal(badge(dir).agent, "done", "a recap with no ask is a finished run");
});

// SW-1005: a question-shaped Stop message replaced the open wrap_up ask with a text guess.
test("hooks: a wrap_up ask outlasts a Stop message that also asks", () => {
  const dir = workspace("h-wrap-up-q", null);
  const fire = (event, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id: "s", ...extra });
  const wrap = { tool_name: "mcp__ccd_turn__wrap_up", tool_input: { ask: "Approve?" } };
  fire("UserPromptSubmit");
  fire("PreToolUse", wrap);
  fire("PostToolUse", wrap);
  fire("Stop", { last_assistant_message: "PR file is written. Ready to merge?" });
  assert.deepEqual([badge(dir).agent, badge(dir).question], ["needs-you", "Approve?"]);
  assert.equal(rec(dir).ask.source, "session", "not the reply-text guess");

  fire("UserPromptSubmit");
  fire("Stop", { last_assistant_message: "Shall I open the PR?" });
  assert.equal(rec(dir).ask.source, "text", "no wrap_up ask: the text guess still applies");
});

// SW-487 fault 4: a new blocking prompt kept the previous question's text.
test("hooks: the permission prompt for a question keeps the question; a later prompt says what it wants", () => {
  const dir = workspace("h-ask-permission", null);
  const fire = (event, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id: "s", ...extra });
  const permission = (tool) =>
    fire("Notification", {
      notification_type: "permission_prompt",
      message: `Claude needs your permission to use ${tool}`,
    });

  fire("UserPromptSubmit");
  fire("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Connect with --docker or host mode?" }] },
  });
  permission("AskUserQuestion");
  assert.deepEqual(
    [rec(dir).ask.kind, rec(dir).ask.what],
    ["question", "Connect with --docker or host mode?"],
  );

  // No PostToolUse in between (the stale case): the next tool's prompt still replaces it.
  fire("PreToolUse", { tool_name: "Bash" });
  permission("Bash");
  assert.deepEqual(
    [rec(dir).ask.kind, rec(dir).ask.what],
    ["permission", "Claude needs your permission to use Bash"],
  );
  fire("PermissionRequest", { tool_name: "Bash", tool_input: { description: "Run tests" } });
  assert.equal(
    rec(dir).ask.what,
    "Claude needs your permission to use Bash",
    "deduped, not replaced",
  );
  fire("PermissionDenied", { tool_name: "Bash" });
  assert.equal(rec(dir).ask, undefined, "a denied call waits on nothing");
});

test("hooks: outside a workspace, without a session id, or on junk input, nothing is written", () => {
  assert.equal(record({ hook_event_name: "Stop", cwd: os.tmpdir(), session_id: "s" }), null);
  const dir = workspace("i-junk", null);
  assert.equal(record({ hook_event_name: "Stop", cwd: dir }), null, "no session id");
  assert.equal(record({ hook_event_name: "Stop", cwd: dir, session_id: "../x" }), null);
  assert.equal(record({ hook_event_name: "Nonsense", cwd: dir, session_id: "s" }), null);
  assert.deepEqual(readSessions(dir), {});
});

// SW-487 fault 2: one record per workspace, so the last writer won.
test("hooks: a second session or a subagent can't wipe a session's ask", async () => {
  const dir = workspace("i-per-session", null);
  const fire = (event, session_id, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id, ...extra });
  fire("UserPromptSubmit", "a");
  fire("PreToolUse", "a", {
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Ship?" }] },
  });
  fire("UserPromptSubmit", "b");
  fire("PreToolUse", "b", { tool_name: "Bash" });
  fire("PostToolUse", "b", { tool_name: "Bash" });
  fire("Stop", "b", { last_assistant_message: "Done." });
  fire("SessionEnd", "b");
  assert.equal(rec(dir, "a").ask.what, "Ship?", "b's turn and exit leave a alone");
  assert.equal(rec(dir, "b"), undefined);

  fire("SubagentStart", "a", { agent_id: "sub-1", agent_type: "Explore" });
  fire("PreToolUse", "a", { agent_id: "sub-1", tool_name: "Read" });
  fire("PostToolUse", "a", { agent_id: "sub-1", tool_name: "Read" });
  assert.equal(rec(dir, "a").ask.what, "Ship?", "a subagent's tools are not the parent's");
  assert.equal(rec(dir, "a").subagents, 1);
  fire("SubagentStop", "a", { agent_id: "sub-1" });
  assert.equal(rec(dir, "a").subagents, undefined);
  // The real sequence for a background agent: started, then the parent's turn ends before it does.
  fire("SubagentStart", "a", { agent_id: "bg-1" });
  fire("Stop", "a", { last_assistant_message: "Started a background agent." });
  const { workspaceState } = await import("../dist/workspace_state.js");
  const blank = {
    now: new Date(),
    signal: { agent: "idle", at: null },
    turnRunning: false,
    processOpen: null,
    paused: null,
    waiting: null,
    services: [],
    crashLoops: [],
    started: null,
    lifecycle: "working",
    postmortemAt: null,
    releasedAt: null,
    closedOut: false,
    stage: null,
    jitPhase: null,
    gates: [],
    heldWakes: [],
    registrySync: [],
    notices: {},
    transcriptAsk: null,
    autonomous: false,
  };
  assert.equal(workspaceState({ ...blank, sessions: readSessions(dir) }).activity.id, "subagent");
  fire("SessionStart", "a");
  assert.equal(rec(dir, "a").subagents, undefined, "a resumed session starts with none");
});

// SW-570: a background shell outlives the turn that started it, like a background agent.
test("hooks: a background shell is kept past its turn's Stop and dropped by the next turn's", () => {
  const dir = workspace("i-shell", null);
  const base = Date.now() - 10_000;
  const t = (n) => new Date(base + n * 1000);
  const fire = (event, n, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id: "a", ...extra }, t(n));
  const bg = { command: "werkmeister pr gate --tests", run_in_background: true };
  fire("UserPromptSubmit", 0);
  fire("PreToolUse", 1, { tool_name: "Bash", tool_input: { command: "git status" } });
  fire("PostToolUse", 1, { tool_name: "Bash" });
  assert.equal(rec(dir, "a").shell, undefined, "a foreground command is no shell");
  fire("PreToolUse", 2, { tool_name: "Bash", tool_input: bg });
  fire("PostToolUse", 2, { tool_name: "Bash" });
  fire("Stop", 3, { last_assistant_message: "Waiting on the gate." });
  assert.deepEqual(rec(dir, "a").shell, { command: bg.command, at: t(2).toISOString() });
  // The shell's exit wakes the session for a turn of its own.
  fire("UserPromptSubmit", 4);
  fire("Stop", 5, { last_assistant_message: "Gate passed." });
  assert.equal(rec(dir, "a").shell, undefined);
  // A wake turn with no prompt hook or tool call still ends it.
  fire("PreToolUse", 6, { tool_name: "Bash", tool_input: bg });
  fire("Stop", 7, { last_assistant_message: "Waiting." });
  fire("Stop", 8, { last_assistant_message: "Done." });
  assert.equal(rec(dir, "a").shell, undefined);
  fire("PreToolUse", 9, { tool_name: "Bash", tool_input: bg });
  fire("SessionStart", 9);
  assert.equal(rec(dir, "a").shell, undefined, "a resumed session has no shells");
});

// SW-681: a stopped session whose background shell still runs is working, and a turn that isn't the
// shell's exit (a person's or a check-in courier's message) must not end the shell.
test("hooks: a background shell outlives a later unrelated turn, and agentOf reads it as working", async () => {
  const dir = workspace("i-shell-681", null);
  const base = Date.now() - 10_000;
  const t = (n) => new Date(base + n * 1000);
  const fire = (event, n, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id: "a", ...extra }, t(n));
  const bg = { command: "werkmeister pr open --watch", run_in_background: true };
  fire("UserPromptSubmit", 0);
  fire("PreToolUse", 1, { tool_name: "Bash", tool_input: bg });
  const started = { tool_name: "Bash", tool_input: bg, tool_response: { backgroundTaskId: "bg1" } };
  fire("PostToolUse", 1, started);
  assert.equal(rec(dir, "a").shell.id, "bg1");
  fire("Stop", 2, { last_assistant_message: "pr open is running in the background." });
  assert.equal(badge(dir).agent, "working", "the shell still runs after Stop");
  // A check-in courier's message: a new turn that is not the shell's exit.
  const transcript = path.join(dir, "transcript.jsonl");
  write(transcript, `${JSON.stringify({ type: "user", message: { content: "check-in" } })}\n`);
  fire("UserPromptSubmit", 3);
  fire("Stop", 4, {
    last_assistant_message: "Still waiting on pr open.",
    transcript_path: transcript,
  });
  assert.equal(rec(dir, "a").shell?.command, bg.command, "the shell has not exited");
  assert.equal(badge(dir).agent, "working");
  // The agent quoting the tag (a grep of its own transcript, a fixture it writes) is no exit.
  const quoted = {
    type: "user",
    message: {
      content: [{ type: "tool_result", content: '"queued_command" <task-id>bg1</task-id>' }],
    },
  };
  fs.appendFileSync(transcript, `${JSON.stringify(quoted)}\n`);
  fire("Stop", 4, { last_assistant_message: "Grepped it.", transcript_path: transcript });
  assert.equal(rec(dir, "a").shell?.id, "bg1", "a quoted tag doesn't end the shell");
  // Its exit notice (seen live: a queued_command attachment), mid-turn or in a wake turn of its own, ends it.
  const notice = "<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>";
  fs.appendFileSync(
    transcript,
    `${JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: notice } })}\n`,
  );
  fire("Stop", 5, { last_assistant_message: "pr open finished.", transcript_path: transcript });
  assert.equal(rec(dir, "a").shell, undefined);
  assert.equal(badge(dir).agent, "done");
  // A TaskStop of it ends it too; one of another task doesn't.
  fire("PreToolUse", 6, { tool_name: "Bash", tool_input: bg });
  fire("PostToolUse", 6, { ...started, tool_response: { backgroundTaskId: "bg2" } });
  fire("PostToolUse", 7, { tool_name: "TaskStop", tool_input: { task_id: "other" } });
  assert.equal(rec(dir, "a").shell.id, "bg2");
  fire("PostToolUse", 7, { tool_name: "TaskStop", tool_input: { task_id: "bg2" } });
  assert.equal(rec(dir, "a").shell, undefined);
  // A shell silent past SESSION_GONE_MS is no longer read as working.
  const { SESSION_GONE_MS } = await import("../dist/agent_state.js");
  const old = new Date(Date.now() - SESSION_GONE_MS - 60_000).toISOString();
  const stale = {
    status: "idle",
    at: old,
    last: old,
    stopped: true,
    shell: { command: "x", at: old },
  };
  assert.equal(agentOf({ a: stale }).agent, "done");
});

// SW-487 fault 7: an unlocked read-modify-write of one shared file lost updates.
test("hooks: interleaved events from many sessions all land", () => {
  const dir = workspace("i-many", null);
  const ids = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < 50; i++) {
    const id = ids[i % ids.length];
    record({
      hook_event_name: i < 45 ? "PreToolUse" : "Stop",
      cwd: dir,
      session_id: id,
      tool_name: `T${i}`,
    });
  }
  const all = readSessions(dir);
  assert.deepEqual(Object.keys(all).sort(), ids);
  for (const id of ids)
    assert.equal(all[id].status, "idle", `${id}'s last event, Stop, is on disk`);
});

// SW-487 fault 5: a session that died without SessionEnd kept its state forever.
test("agentOf: a busy session silent past SESSION_GONE_MS is no longer working", async () => {
  const { SESSION_GONE_MS, sessionGone } = await import("../dist/agent_state.js");
  const now = Date.parse("2026-11-06T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const busy = (ms) => ({ status: "busy", at: at(ms), last: at(ms) });
  assert.equal(sessionGone(busy(SESSION_GONE_MS - 60_000), now), false);
  assert.equal(sessionGone(busy(SESSION_GONE_MS + 60_000), now), true);
  assert.equal(sessionGone({ status: "idle", at: at(SESSION_GONE_MS * 10) }, now), false);
  assert.equal(agentOf({ s: busy(SESSION_GONE_MS + 60_000) }, now).agent, "idle");
  assert.equal(agentOf({ s: busy(60_000) }, now).agent, "working");
});

// SW-559: a crash never sends SessionEnd, so without an expiry a dead record was probed on every sweep.
test("readSessions: a busy record with no ask, silent for STALE_SESSION_MS, is dropped and its file deleted", async () => {
  const { STALE_SESSION_MS } = await import("../dist/agent_state.js");
  const dir = workspace("j-stale", null);
  const now = Date.parse("2026-11-06T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const file = (id) => path.join(dir, ".werkmeister", "sessions", `${id}.json`);
  const old = at(STALE_SESSION_MS + 1);
  const ask = { kind: "permission", what: "Bash", at: old, source: "session" };
  write(file("dead"), JSON.stringify({ status: "busy", at: at(STALE_SESSION_MS * 2), last: old }));
  write(file("recent"), JSON.stringify({ status: "busy", at: at(STALE_SESSION_MS - 60_000) }));
  write(file("asking"), JSON.stringify({ status: "busy", at: old, last: old, ask }));
  write(file("idle"), JSON.stringify({ status: "idle", at: old, last: old }));
  write(file("junk-date"), JSON.stringify({ status: "busy", at: "not a date" }));
  assert.deepEqual(Object.keys(readSessions(dir, now)).sort(), ["asking", "idle", "recent"]);
  assert.equal(fs.existsSync(file("dead")), false, "the stale file is deleted");
  assert.equal(fs.existsSync(file("junk-date")), false);
  assert.equal(fs.existsSync(file("recent")), true);

  // A delete that fails (a read-only or foreign-owned dir) still leaves the record out, and never throws.
  write(file("dead"), JSON.stringify({ status: "busy", at: old, last: old }));
  const sessions = path.dirname(file("dead"));
  fs.chmodSync(sessions, 0o500);
  try {
    assert.deepEqual(Object.keys(readSessions(dir, now)).sort(), ["asking", "idle", "recent"]);
  } finally {
    fs.chmodSync(sessions, 0o755);
  }
});

test("nextSession: PermissionRequest asks with the tool's description, else the tool name", () => {
  const now = new Date("2026-11-06T10:00:00Z");
  const ask = (tool_input) =>
    nextSession({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input }, null, now)
      .ask;
  assert.equal(ask({ command: "rm -rf x", description: "Delete x" }).what, "Delete x");
  assert.equal(ask({ command: "rm -rf x", description: null }).what, "Approve Bash?");
});

// SW-182: the liveness record idle-stop and the resume nudge read, not Claude's session files.

test("hooks: each session id gets a busy/idle record; SessionEnd drops it", () => {
  const dir = workspace("i-sessions", null);
  const fire = (event, session_id, now) =>
    record({ hook_event_name: event, cwd: dir, session_id }, now);
  // Recent: SW-559 drops a busy record silent past STALE_SESSION_MS.
  const t0 = new Date(Date.now() - 10 * 60_000);
  const t1 = new Date(t0.getTime() + 5 * 60_000);

  fire("SessionStart", "a", t0);
  assert.deepEqual(readSessions(dir), {
    a: { status: "idle", at: t0.toISOString(), last: t0.toISOString() },
  });
  assert.equal(badge(dir), null, "a session start alone is no agent state");
  fire("UserPromptSubmit", "a", t1);
  fire("PreToolUse", "b", t1);
  assert.deepEqual(
    [readSessions(dir).a.status, readSessions(dir).a.at, readSessions(dir).b.status],
    ["busy", t1.toISOString(), "busy"],
  );
  assert.deepEqual(agentOf(readSessions(dir), t1.getTime()), {
    agent: "working",
    at: t1.toISOString(),
    question: null,
  });

  fire("Stop", "a", t1);
  assert.equal(readSessions(dir).a.status, "idle");
  fire("SessionEnd", "b", t1);
  assert.deepEqual(Object.keys(readSessions(dir)), ["a"]);
  fire("Notification", "a", t1);
  assert.equal(readSessions(dir).a.status, "idle", "a notification is no status change");
  fire("Stop", undefined, t1);
  assert.deepEqual(Object.keys(readSessions(dir)), ["a"], "no session id: no record");
});

// SW-397: `claude -p --resume <id>` (claude-send, Resume's headless nudge, a pr-watch wake)
// shares the open session's id, so its SessionEnd must not erase that session's record.
test("hooks: a headless turn ending on an open session's id keeps that session live", () => {
  const dir = workspace("i-shared-id", null);
  const fire = (event, id = "s") => record({ hook_event_name: event, cwd: dir, session_id: id });
  fire("SessionStart");
  fire("UserPromptSubmit");
  fire("Stop");
  const was = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
  try {
    fire("SessionStart");
    fire("UserPromptSubmit");
    assert.equal(
      readSessions(dir).s.status,
      "busy",
      "a headless turn still marks the session busy",
    );
    fire("Stop");
    fire("SessionEnd");
    fire("SessionStart", "h");
    assert.equal(readSessions(dir).h.status, "idle", "a headless-only turn is live while it runs");
    fire("SessionEnd", "h");
    fire("SessionStart", "x");
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    fire("SessionStart", "x");
    process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
    fire("SessionEnd", "x");
    assert.ok(
      readSessions(dir).x,
      "an interactive session on a headless-made id is no longer headless",
    );
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = was;
  }
  assert.equal(readSessions(dir).s?.headless, undefined, "the interactive session is still open");
  assert.deepEqual(
    Object.keys(readSessions(dir)).sort(),
    ["s", "x"],
    "the headless turn ended its own record",
  );
});

test("hooks: a headless wake turn on an open session's id leaves its ask (SW-487)", () => {
  const dir = workspace("i-wake-ask", null);
  const fire = (event, extra = {}) =>
    record({ hook_event_name: event, cwd: dir, session_id: "s", ...extra });
  fire("UserPromptSubmit");
  fire("Stop", { last_assistant_message: "Merge it now?" });
  const was = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
  try {
    fire("UserPromptSubmit");
    fire("PreToolUse", { tool_name: "Bash" });
    fire("Stop", { last_assistant_message: "Fixed CI." });
    fire("SessionEnd");
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = was;
  }
  assert.equal(rec(dir).ask.what, "Merge it now?");
});

// SW-70: while `paused.json` exists the same hook holds the session.
const { pauseGate, PAUSED_REASON, writePaused, writeNudge } = await import(
  "../dist/agent_state.js"
);

test("pause gate: PreToolUse ends the turn and denies, UserPromptSubmit blocks, the rest pass", () => {
  const dir = workspace("j-gate", null);
  for (const e of ["PreToolUse", "UserPromptSubmit", "Stop"])
    assert.equal(pauseGate({ hook_event_name: e }, dir), null, `${e} with no marker`);
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: true });
  const pre = pauseGate({ hook_event_name: "PreToolUse", tool_name: "Bash" }, dir);
  assert.equal(pre.continue, false);
  assert.equal(pre.stopReason, PAUSED_REASON);
  assert.equal(pre.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(pauseGate({ hook_event_name: "UserPromptSubmit" }, dir).decision, "block");
  for (const e of ["PostToolUse", "Notification", "Stop", "SessionEnd"])
    assert.equal(pauseGate({ hook_event_name: e }, dir), null, e);
});

// SW-181: waiting.json holds the session the same way; paused wins when both exist.
const { writeWaiting, serviceWaitContext, writeWakeNudge, liveWaiting, waitingPath } = await import(
  "../dist/agent_state.js"
);

const bash = (command) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});
const DOCKER_EXEC = bash("docker exec demo-core pnpm test");

test("waiting gate: denies a container command with the queue position", () => {
  const dir = workspace("j-wait", null);
  writeWaiting(dir, { position: 2, reason: "waiting for capacity" });
  const pre = pauseGate(DOCKER_EXEC, dir);
  // SW-992: ending the turn left the session idle on a grant notice that could be lost.
  assert.equal(pre.continue, undefined, "queued, the turn goes on");
  assert.equal(pre.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(
    pre.hookSpecificOutput.permissionDecisionReason,
    /Waiting for capacity \(position 2\)/,
  );
  // SW-909: an agent read the old text as "not admitted" and stopped over running containers.
  assert.match(
    pre.hookSpecificOutput.permissionDecisionReason,
    /docker ps --filter label=com\.werkmeister\.feature=/,
  );
  assert.match(pre.hookSpecificOutput.permissionDecisionReason, /grant/);
  // SW-991: an agent stopped and asked a person over a stale entry; the text says how to check it itself.
  assert.match(
    pre.hookSpecificOutput.permissionDecisionReason,
    /run `werkmeister budget status`\. If it lists this workspace under Running, this queue entry is stale: rerun/,
  );
  assert.equal(pre.hookSpecificOutput.permissionDecision, "deny");
  // The check the text names must pass the hook; a chained or other docker command still waits.
  assert.equal(pauseGate(bash("docker ps --filter label=com.werkmeister.feature=demo"), dir), null);
  assert.equal(
    pauseGate(bash("docker ps; docker exec demo-core pnpm test"), dir)?.hookSpecificOutput
      ?.permissionDecision,
    "deny",
  );
  assert.equal(
    pauseGate(bash("docker ps $(docker run x)"), dir)?.hookSpecificOutput?.permissionDecision,
    "deny",
  );
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: false });
  assert.equal(pauseGate({ hook_event_name: "PreToolUse" }, dir).stopReason, PAUSED_REASON);
});

// SW-768: queued, the hook held Edit on the PR file and git on the record, so a person's approval
// couldn't be written; only what needs containers or the CPUs waits.
test("waiting gate: holds container and test commands only; the record, git and prompts go on", () => {
  const dir = workspace("j-wait-narrow", null);
  writeWaiting(dir, { position: 1, reason: "waiting for capacity" });
  for (const command of [
    "docker exec demo-core pnpm test",
    "cd /x && pnpm turbo run test",
    "/ws/.werkmeister/bin/with-temp-home --no-wait node --test a.test.mjs",
    "werkmeister feature restart",
    "werkmeister pr gate --tests",
    "w9r pr open",
    "sh -c 'docker compose up -d'",
  ])
    assert.equal(
      pauseGate(bash(command), dir)?.hookSpecificOutput?.permissionDecision,
      "deny",
      command,
    );
  assert.equal(
    pauseGate(
      { hook_event_name: "PreToolUse", tool_name: "mcp__plugin_werkmeister_werkmeister__restart" },
      dir,
    )?.hookSpecificOutput?.permissionDecision,
    "deny",
  );
  // SW-992: `feature up` only re-asks admission (exit 75 while there is no room): holding it was the deadlock
  // that kept a queued session from starting after the budget grew.
  for (const command of ["werkmeister feature up", "werkmeister feature up --service core"])
    assert.equal(pauseGate(bash(command), dir), null, command);
  assert.equal(
    pauseGate(
      { hook_event_name: "PreToolUse", tool_name: "mcp__plugin_werkmeister_werkmeister__up" },
      dir,
    ),
    null,
  );
  // SW-832: the MCP forms of the held Bash commands; `workspace-pr status` passes like `pr status`.
  const mcp = (tool, tool_input = {}) => ({
    hook_event_name: "PreToolUse",
    tool_name: `mcp__plugin_werkmeister_werkmeister__${tool}`,
    tool_input,
  });
  for (const input of [
    mcp("restart"),
    mcp("test"),
    mcp("workspace-pr", { action: "gate" }),
    mcp("workspace-pr", { action: "open" }),
  ])
    assert.equal(
      pauseGate(input, dir)?.hookSpecificOutput?.permissionDecision,
      "deny",
      input.tool_name,
    );
  for (const input of [
    mcp("workspace-pr", { action: "status" }),
    mcp("workspace-prs"),
    mcp("stop"),
  ])
    assert.equal(pauseGate(input, dir), null, input.tool_name);
  for (const command of [
    "git add stages && git commit -m 'approved' && git push",
    'git commit -m "restart docker after node upgrade"',
    "werkmeister feature stop",
    "werkmeister budget status",
    "ls stages/*/output/",
  ])
    assert.equal(pauseGate(bash(command), dir), null, command);
  for (const tool of ["Edit", "Write", "Read", "Grep"])
    assert.equal(pauseGate({ hook_event_name: "PreToolUse", tool_name: tool }, dir), null, tool);
  assert.equal(pauseGate({ hook_event_name: "UserPromptSubmit" }, dir), null);
  // Paused still holds everything.
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: false });
  assert.equal(
    pauseGate({ hook_event_name: "PreToolUse", tool_name: "Edit" }, dir).continue,
    false,
  );
  assert.equal(pauseGate({ hook_event_name: "UserPromptSubmit" }, dir).decision, "block");
});

// SW-713: a waiting.json its feature's queue entry outlived held the session with a stale position
// while budget status showed nothing waiting.
test("waiting gate: a waiting.json the queue no longer holds is cleared and holds nothing", () => {
  const dir = workspace("j-wait-stale", null);
  write(path.join(dir, ".env"), "FEATURE=stale\n");
  const cfg = path.join(root, "stale-home", "config.yaml");
  const queue = path.join(path.dirname(cfg), "scheduler", "queue.json");
  const was = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = cfg;
  const old = (ms) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(waitingPath(dir), when, when);
  };
  try {
    write(queue, JSON.stringify(["stale"]));
    writeWaiting(dir, { position: 2, reason: "waiting for capacity" });
    old(60_000);
    assert.equal(
      pauseGate(DOCKER_EXEC, dir).hookSpecificOutput?.permissionDecision,
      "deny",
      "still queued",
    );

    write(queue, JSON.stringify(["other"]));
    writeWaiting(dir, { position: 2, reason: "waiting for capacity" });
    assert.equal(
      pauseGate(DOCKER_EXEC, dir).hookSpecificOutput?.permissionDecision,
      "deny",
      "just written: the queue may not have caught up",
    );
    old(60_000);
    assert.equal(pauseGate(DOCKER_EXEC, dir), null);
    assert.equal(fs.existsSync(waitingPath(dir)), false);
  } finally {
    if (was === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = was;
  }
});

// SW-986: the hook held `pr open` as queued while the workspace's container had been up 39 minutes, so
// no grant ever came. Before it holds a command it asks Docker; a running container makes the entry stale.
test("waiting gate: a queued workspace whose containers run is not held, and its record goes", () => {
  const dir = workspace("j-wait-up", null);
  write(path.join(dir, ".env"), "FEATURE=upnow\n");
  const cfg = path.join(root, "up-home", "config.yaml");
  const queue = path.join(path.dirname(cfg), "scheduler", "queue.json");
  const fake = path.join(root, "up-home", "docker");
  const args = path.join(root, "up-home", "docker-args");
  const as = (body) => {
    write(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n${body}\n`);
    fs.chmodSync(fake, 0o755);
  };
  const was = [process.env.WERKMEISTER_CONFIG_FILE, process.env.WERKMEISTER_DOCKER_BIN];
  process.env.WERKMEISTER_CONFIG_FILE = cfg;
  process.env.WERKMEISTER_DOCKER_BIN = fake;
  try {
    write(queue, JSON.stringify(["upnow"]));
    writeWaiting(dir, { position: 1, reason: "preempted" });
    for (const [body, why] of [
      ["exit 0", "no container runs"],
      ["exit 1", "Docker unreadable: unsure, so it still holds"],
    ]) {
      as(body);
      assert.equal(
        pauseGate(DOCKER_EXEC, dir)?.hookSpecificOutput?.permissionDecision,
        "deny",
        why,
      );
    }
    assert.match(fs.readFileSync(args, "utf8"), /label=com\.werkmeister\.feature=upnow/);
    as("echo abc123");
    assert.equal(pauseGate(DOCKER_EXEC, dir), null);
    assert.equal(fs.existsSync(waitingPath(dir)), false);
  } finally {
    for (const [k, v] of [
      ["WERKMEISTER_CONFIG_FILE", was[0]],
      ["WERKMEISTER_DOCKER_BIN", was[1]],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// SW-545: a service start waiting for capacity (waiting.json with `services`, SW-540) is the session's
// own job, so the person can still prompt it and it can still run tools to answer or stop the wait.
test("waiting gate: a service-start wait lets prompts and tools through, naming the wait", () => {
  const dir = workspace("j-wait-svc", null);
  writeWaiting(dir, {
    position: 1,
    reason: "waiting for capacity",
    services: ["docs-site", "werkmeister-install"],
  });
  assert.equal(pauseGate({ hook_event_name: "UserPromptSubmit" }, dir), null, "not blocked");
  const ctx = serviceWaitContext({ hook_event_name: "UserPromptSubmit" }, dir);
  assert.equal(serviceWaitContext({ hook_event_name: "PreToolUse" }, dir), null);
  assert.match(ctx, /position 1/);
  assert.match(ctx, /docs-site, werkmeister-install/);
  assert.match(ctx, /stop/i, "says how to stop the wait");
  assert.equal(pauseGate({ hook_event_name: "PreToolUse", tool_name: "Bash" }, dir), null);
  // A whole-feature queue (no services) still holds container commands (SW-768).
  writeWaiting(dir, { position: 1, reason: "waiting for capacity" });
  assert.equal(pauseGate(DOCKER_EXEC, dir).hookSpecificOutput?.permissionDecision, "deny");
});

// SW-701: a parked start has no poll, so an old file is still live and the context says nothing polls.
test("waiting gate: a parked service start stays live past 60 s and lets tools through", () => {
  const dir = workspace("j-wait-parked", null);
  write(path.join(dir, ".env"), "FEATURE=parked\n");
  const cfg = path.join(root, "parked-home", "config.yaml");
  const queue = path.join(path.dirname(cfg), "scheduler", "queue.json");
  const was = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = cfg;
  const park = () => {
    writeWaiting(dir, {
      position: 2,
      reason: "waiting for capacity",
      services: ["api"],
      parked: { service: "api" },
    });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(waitingPath(dir), old, old);
  };
  try {
    write(queue, JSON.stringify(["parked"]));
    park();
    assert.equal(liveWaiting(dir)?.parked?.service, "api");
    const ctx = serviceWaitContext({ hook_event_name: "UserPromptSubmit" }, dir);
    // Its place in queue.json now, not the stored 2 (SW-988).
    assert.match(ctx, /start of api is queued for capacity \(position 1\)/);
    assert.match(ctx, /Nothing polls/);
    assert.equal(pauseGate({ hook_event_name: "PreToolUse", tool_name: "Bash" }, dir), null);
    // Its queue entry gone (`feature down`): the promise is false, so the file goes (SW-701 review).
    write(queue, JSON.stringify([]));
    assert.equal(serviceWaitContext({ hook_event_name: "UserPromptSubmit" }, dir), null);
    assert.equal(fs.existsSync(waitingPath(dir)), false);
  } finally {
    if (was === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = was;
  }
});

/** Run the hook entrypoint as Claude Code does: the event on stdin, the gate on stdout. */
function hook(event) {
  const entry = new URL("../dist/agent_state.js", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { main } from "${entry}"; main();`],
    { input: JSON.stringify(event), encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("pause gate: the hook entry prints it from the code worktree and records nothing", () => {
  const dir = workspace("k-main", null);
  const cwd = path.join(dir, "sandbox", "apps");
  fs.mkdirSync(cwd, { recursive: true });
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: false });
  const s = { cwd, session_id: "s" };
  assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Edit", ...s }).continue, false);
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", ...s }).decision, "block");
  assert.deepEqual(readSessions(dir), {}, "a blocked call must not read as working");
});

test("pause gate: an unblocked prompt clears a stale resume nudge", () => {
  const dir = workspace("l-nudge", null);
  writeNudge(dir, "continue");
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "s" }), null);
  assert.equal(fs.existsSync(path.join(dir, ".werkmeister", "resume-nudge.json")), false);
  assert.equal(badge(dir).agent, "working");
});

// SW-545: the entry prints the wait as context, and the prompt still clears the nudge and is recorded.
test("service-start wait: the hook entry adds context and records the prompt", async () => {
  const dir = workspace("l-wait-svc", null);
  writeWaiting(dir, { position: 3, reason: "waiting for capacity", services: ["lib"] });
  writeNudge(dir, "continue");
  const out = hook({ hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "s" });
  assert.match(out.hookSpecificOutput.additionalContext, /position 3\): lib\./);
  assert.equal(fs.existsSync(path.join(dir, ".werkmeister", "resume-nudge.json")), false);
  assert.equal(readSessions(dir).s.status, "busy", "an unblocked prompt is recorded");
  assert.equal(
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, session_id: "s" }),
    null,
  );
  // A held wake on the same prompt rides along after the wait, in the one JSON object the hook prints.
  writeWakeNudge(dir, "s", "PR merged.");
  const both = hook({ hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "s" });
  assert.match(
    both.hookSpecificOutput.additionalContext,
    /position 3\): lib\.[\s\S]*\n\nPR merged\./,
  );
  // A poll that died (killed job) leaves the file behind; after 60 s it is no wait at all.
  const stale = new Date(Date.now() - 61_000);
  fs.utimesSync(path.join(dir, ".werkmeister", "waiting.json"), stale, stale);
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "s" }), null);
  // SW-570: nor does the state read it, so a left-behind file can't hold a gate forever.
  assert.equal(liveWaiting(dir), null);
  hook({ hook_event_name: "Stop", cwd: dir, session_id: "s", last_assistant_message: "Done." });
  const activity = async () =>
    (await getWorkspaceStatuses()).statuses.find((s) => s.name === "l-wait-svc").workspaceState
      .activity.id;
  assert.equal(await activity(), "idle");
  const fresh = new Date();
  fs.utimesSync(path.join(dir, ".werkmeister", "waiting.json"), fresh, fresh);
  assert.equal(await activity(), "queued", "a live wait still shows once the turn ends");
});

test("wake nudge: held until the session's next hook delivers it, once (SW-418)", () => {
  const dir = workspace("l-wake", null);
  const file = path.join(dir, ".werkmeister", "wake-nudge-s-1.json");
  const fire = (e, extra = {}) =>
    hook({ hook_event_name: e, cwd: dir, session_id: "s-1", ...extra });
  write(file, JSON.stringify({ message: "PR 9 conflicts with main, resolve it." }));
  assert.equal(fire("PreToolUse", { tool_name: "Bash" }), null);
  assert.ok(fs.existsSync(file), "its own PreToolUse doesn't take it");
  assert.equal(
    fire("PostToolUse", { session_id: "other", tool_name: "Bash" }),
    null,
    "not another session's",
  );
  assert.equal(
    fire("PostToolUse", { agent_id: "sub-1", tool_name: "Bash" }),
    null,
    "not a subagent's, which shares the session id",
  );
  const out = fire("PostToolUse", { tool_name: "Bash" });
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /PR 9 conflicts with main/);
  assert.equal(fs.existsSync(file), false, "delivered once");
  assert.equal(badge(dir).agent, "working");
  write(file, JSON.stringify({ message: "PR 9 merged." }));
  assert.match(fire("UserPromptSubmit").hookSpecificOutput.additionalContext, /PR 9 merged/);
  write(file, JSON.stringify({ message: "PR 9 merged." }));
  const stop = fire("Stop", { last_assistant_message: "Done." });
  assert.equal(stop.decision, "block", "a turn ending first still gets it");
  assert.match(stop.reason, /PR 9 merged/);
  assert.equal(fs.existsSync(file), false);
});

test("wake nudge: a write or a second hook landing mid-delivery is neither lost nor sent twice (SW-444)", async () => {
  const { deliverWake, writeWakeNudge } = await import("../dist/agent_state.js");
  const { syncBuiltinESMExports } = await import("node:module");
  const fsc = (await import("node:fs")).default;
  const real = fsc.readFileSync;
  // While the hook reads the nudge, pr watch appends B, and (withHook) a parallel hook delivers.
  for (const withHook of [false, true]) {
    const dir = workspace(`l-race-${withHook}`, null);
    const input = { hook_event_name: "PostToolUse", session_id: "s-1", cwd: dir };
    let nested = null;
    let armed = true;
    fsc.readFileSync = function (p, ...rest) {
      const out = real.call(this, p, ...rest);
      if (armed && String(p).includes("wake-nudge")) {
        armed = false;
        writeWakeNudge(dir, "s-1", "B");
        if (withHook) nested = deliverWake(input, dir);
      }
      return out;
    };
    syncBuiltinESMExports();
    try {
      writeWakeNudge(dir, "s-1", "A");
      armed = true;
      const got = [deliverWake(input, dir), nested];
      fsc.readFileSync = real;
      syncBuiltinESMExports();
      got.push(deliverWake(input, dir));
      const texts = got.filter(Boolean).map((o) => o.hookSpecificOutput.additionalContext);
      const seen = JSON.stringify(texts);
      assert.equal(
        texts.filter((t) => t.includes("A")).length,
        1,
        `A once (withHook ${withHook}): ${seen}`,
      );
      assert.equal(
        texts.filter((t) => t.includes("B")).length,
        1,
        `B once (withHook ${withHook}): ${seen}`,
      );
    } finally {
      fsc.readFileSync = real;
      syncBuiltinESMExports();
    }
  }
});

test("wake nudge: a hook delivering while pr watch appends sends the held wake once (SW-475)", async () => {
  const { deliverWake, writeWakeNudge } = await import("../dist/agent_state.js");
  const { syncBuiltinESMExports } = await import("node:module");
  const fsc = (await import("node:fs")).default;
  const real = fsc.readFileSync;
  const dir = workspace("l-race-writer", null);
  const input = { hook_event_name: "PostToolUse", session_id: "s-1", cwd: dir };
  writeWakeNudge(dir, "s-1", "A");
  // Writer first: pr watch reads A, a hook delivers meanwhile, then pr watch writes back.
  let nested = null;
  let armed = true;
  fsc.readFileSync = function (p, ...rest) {
    const out = real.call(this, p, ...rest);
    if (armed && String(p).includes("wake-nudge")) {
      armed = false;
      nested = deliverWake(input, dir);
    }
    return out;
  };
  syncBuiltinESMExports();
  try {
    writeWakeNudge(dir, "s-1", "B");
  } finally {
    fsc.readFileSync = real;
    syncBuiltinESMExports();
  }
  const texts = [nested, deliverWake(input, dir)]
    .filter(Boolean)
    .map((o) => o.hookSpecificOutput.additionalContext);
  const seen = JSON.stringify(texts);
  assert.equal(texts.filter((t) => t.includes("A")).length, 1, `A once: ${seen}`);
  assert.equal(texts.filter((t) => t.includes("B")).length, 1, `B once: ${seen}`);
});

test("wake nudge: a failed write keeps the held wake deliverable (SW-502)", async () => {
  const { deliverWake, writeWakeNudge, wakeNudgePath } = await import("../dist/agent_state.js");
  const { syncBuiltinESMExports } = await import("node:module");
  const fsc = (await import("node:fs")).default;
  const real = fsc.writeFileSync;
  const dir = workspace("l-failed-write", null);
  const input = { hook_event_name: "PostToolUse", session_id: "s-1", cwd: dir };
  const failWrites = (on) => {
    fsc.writeFileSync = on
      ? (p, ...rest) => {
          if (String(p).includes("wake-nudge")) throw new Error("ENOSPC");
          return real.call(fsc, p, ...rest);
        }
      : real;
    syncBuiltinESMExports();
  };
  // No wake held: the error propagates and nothing is left behind.
  failWrites(true);
  try {
    assert.throws(() => writeWakeNudge(dir, "s-1", "X"), /ENOSPC/);
  } finally {
    failWrites(false);
  }
  assert.equal(fsc.existsSync(wakeNudgePath(dir, "s-1")), false);
  // A wake is held: a failed append restores it.
  writeWakeNudge(dir, "s-1", "A");
  failWrites(true);
  try {
    assert.throws(() => writeWakeNudge(dir, "s-1", "B"), /ENOSPC/);
  } finally {
    failWrites(false);
  }
  const out = deliverWake(input, dir);
  assert.ok(out?.hookSpecificOutput.additionalContext.includes("A"), JSON.stringify(out));
  assert.deepEqual(
    fsc.readdirSync(path.dirname(wakeNudgePath(dir, "s-1"))).filter((n) => n.endsWith(".claimed")),
    [],
  );
});

test("status: a paused workspace reports when, what Resume brings back, and a pending nudge", async () => {
  const dir = workspace("m-status", null);
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: ["m-api"], was_working: true });
  writeNudge(dir, "continue");
  const s = (await getWorkspaceStatuses()).statuses.find((w) => w.name === "m-status");
  assert.deepEqual(s.paused, { at: "2026-10-22T10:00:00.000Z", containers: ["m-api"] });
  assert.equal(s.resumeNudge, true);
  // "unknown" when this machine has no reachable daemon: the record can't say more than docker.
  assert.ok(["paused", "unknown"].includes(s.state), s.state);
  const other = (await getWorkspaceStatuses()).statuses.find((w) => w.name === "j-gate");
  assert.equal(other.resumeNudge, false);
});

test("status: heldWakes lists each session with a held wake, not a claimed or malformed file (SW-463)", async () => {
  const { writeWakeNudge, wakeNudgePath } = await import("../dist/agent_state.js");
  const dir = workspace("m-wakes", null);
  writeWakeNudge(dir, "s-1", "PR merged");
  writeWakeNudge(dir, "s-2", "PR shipped");
  write(`${wakeNudgePath(dir, "s-3")}.123-456.claimed`, "{}");
  write(wakeNudgePath(dir, "bad id"), "{}");
  const s = (await getWorkspaceStatuses()).statuses.find((w) => w.name === "m-wakes");
  assert.deepEqual(s.heldWakes.map((w) => w.session).sort(), ["s-1", "s-2"]);
  const at = fs.statSync(wakeNudgePath(dir, "s-1")).mtime.toISOString();
  assert.equal(s.heldWakes.find((w) => w.session === "s-1").at, at);
  const other = (await getWorkspaceStatuses()).statuses.find((w) => w.name === "j-gate");
  assert.deepEqual(other.heldWakes, []);
});

// SW-189: Codex fails a PreToolUse hook whose output carries continue/stopReason, and runs the tool.
test("pause gate on Codex: PreToolUse denies without continue or stopReason", () => {
  const dir = workspace("j-gate-codex", null);
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: true });
  process.env.WERKMEISTER_HOOK_HARNESS = "codex";
  try {
    const pre = pauseGate({ hook_event_name: "PreToolUse", tool_name: "Bash" }, dir);
    assert.deepEqual(Object.keys(pre), ["hookSpecificOutput"]);
    assert.equal(pre.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(pre.hookSpecificOutput.permissionDecisionReason, PAUSED_REASON);
    assert.equal(pauseGate({ hook_event_name: "UserPromptSubmit" }, dir).decision, "block");
  } finally {
    delete process.env.WERKMEISTER_HOOK_HARNESS;
  }
});

// SW-487 fault 8: system notices shared needs-you with questions, and any tool call cleared them.
test("notices: raised and cleared by their owner, never by a hook event", async () => {
  const { raiseNotice, clearNotice, readNotices } = await import("../dist/agent_state.js");
  const dir = workspace("n-notices", null);
  raiseNotice(dir, "autofix-app", {
    what: "auto-fix blocked",
    action: "Approve",
    url: "https://x/pr/1",
  });
  for (const e of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"])
    hook({ hook_event_name: e, cwd: dir, session_id: "s", tool_name: "Bash" });
  assert.equal(readNotices(dir)["autofix-app"].what, "auto-fix blocked");
  assert.equal(readNotices(dir)["autofix-app"].url, "https://x/pr/1");
  clearNotice(dir, "autofix-app");
  assert.deepEqual(readNotices(dir), {});
});

// SW-558: the one-release read of the pre-SW-487 file is gone (SW-487 shipped in werkmeister@0.83.0).
test("readSessions: agent-state.json sessions{} no longer count", () => {
  const dir = workspace("i-legacy-gone", null);
  const at = new Date().toISOString();
  write(
    path.join(dir, ".werkmeister", "agent-state.json"),
    JSON.stringify({ sessions: { old: { status: "busy", at } } }),
  );
  assert.deepEqual(readSessions(dir), {});
});
