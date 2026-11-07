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
process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";
process.env.WERKMEISTER_WORKSPACES_ROOT = root;

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
  "./dist/agent_state.js"
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
  const t0 = new Date("2026-10-19T10:00:00Z");

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
  const { workspaceState } = await import("./dist/workspace_state.js");
  const blank = {
    now: new Date(),
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
  };
  assert.equal(workspaceState({ ...blank, sessions: readSessions(dir) }).activity.id, "subagent");
  fire("SessionStart", "a");
  assert.equal(rec(dir, "a").subagents, undefined, "a resumed session starts with none");
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
  const { SESSION_GONE_MS, sessionGone } = await import("./dist/agent_state.js");
  const now = Date.parse("2026-11-06T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const busy = (ms) => ({ status: "busy", at: at(ms), last: at(ms) });
  assert.equal(sessionGone(busy(SESSION_GONE_MS - 60_000), now), false);
  assert.equal(sessionGone(busy(SESSION_GONE_MS + 60_000), now), true);
  assert.equal(sessionGone({ status: "idle", at: at(SESSION_GONE_MS * 10) }, now), false);
  assert.equal(agentOf({ s: busy(SESSION_GONE_MS + 60_000) }, now).agent, "idle");
  assert.equal(agentOf({ s: busy(60_000) }, now).agent, "working");
});

test("readSessions: pre-SW-487 agent-state.json sessions still count until their own file exists", () => {
  const dir = workspace("i-legacy", null);
  const at = "2026-11-01T10:00:00.000Z";
  write(
    path.join(dir, ".werkmeister", "agent-state.json"),
    JSON.stringify({
      state: "working",
      at,
      sessions: { old: { status: "busy", at }, both: { status: "busy", at } },
    }),
  );
  record({ hook_event_name: "Stop", cwd: dir, session_id: "both" });
  assert.equal(readSessions(dir).old.status, "busy");
  assert.equal(readSessions(dir).both.status, "idle", "its own file wins");
  record({ hook_event_name: "SessionEnd", cwd: dir, session_id: "both" });
  assert.equal(
    readSessions(dir).both,
    undefined,
    "an ended session doesn't come back from the old file",
  );
  record({ hook_event_name: "SessionEnd", cwd: dir, session_id: "old" });
  assert.equal(readSessions(dir).old, undefined, "ending removes it from the old file");
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
  const t0 = new Date("2026-10-29T10:00:00Z");
  const t1 = new Date("2026-10-29T10:05:00Z");

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
const { pauseGate, PAUSED_REASON, writePaused, writeNudge } = await import("./dist/agent_state.js");

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
const { writeWaiting } = await import("./dist/agent_state.js");

test("waiting gate: denies tool calls and blocks prompts with the queue position", () => {
  const dir = workspace("j-wait", null);
  writeWaiting(dir, { position: 2, reason: "waiting for capacity" });
  const pre = pauseGate({ hook_event_name: "PreToolUse", tool_name: "Bash" }, dir);
  assert.equal(pre.continue, false);
  assert.match(pre.stopReason, /Waiting for capacity \(position 2\)/);
  assert.equal(pre.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    pauseGate({ hook_event_name: "UserPromptSubmit" }, dir).reason,
    /waiting for capacity/,
  );
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: false });
  assert.equal(pauseGate({ hook_event_name: "PreToolUse" }, dir).stopReason, PAUSED_REASON);
});

/** Run the hook entrypoint as Claude Code does: the event on stdin, the gate on stdout. */
function hook(event) {
  const entry = new URL("./dist/agent_state.js", import.meta.url).href;
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
  const { deliverWake, writeWakeNudge } = await import("./dist/agent_state.js");
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
  const { deliverWake, writeWakeNudge } = await import("./dist/agent_state.js");
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
  const { deliverWake, writeWakeNudge, wakeNudgePath } = await import("./dist/agent_state.js");
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
  const { writeWakeNudge, wakeNudgePath } = await import("./dist/agent_state.js");
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
  const { raiseNotice, clearNotice, readNotices } = await import("./dist/agent_state.js");
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
