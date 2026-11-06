// SW-46: a workspace's agent state — working / needs-you / done / idle — from the
// state file Claude Code hooks write, else from the transcript tail.

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

test("hooks: a Desktop wrap_up ask is needs-you even when the closing message asks nothing", () => {
  const dir = workspace("h-wrap-up", null);
  const fire = (event, extra = {}) => record({ hook_event_name: event, cwd: dir, ...extra });
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
    [readAgentState(dir).state, readAgentState(dir).question],
    ["needs-you", "Is the spec approved for 03_implement?"],
  );

  fire("UserPromptSubmit");
  wrapUp({ recap: "PR #12 is open." });
  assert.equal(readAgentState(dir).state, "done", "a recap with no ask is a finished run");
});

test("hooks: the permission prompt for a question keeps the question, not the prompt text", () => {
  const dir = workspace("h-ask-permission", null);
  const fire = (event, extra = {}) => record({ hook_event_name: event, cwd: dir, ...extra });
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
    [readAgentState(dir).state, readAgentState(dir).question],
    ["needs-you", "Connect with --docker or host mode?"],
  );

  fire("PostToolUse", { tool_name: "AskUserQuestion" });
  fire("PreToolUse", { tool_name: "Bash" });
  permission("Bash");
  assert.equal(
    readAgentState(dir).question,
    "Claude needs your permission to use Bash",
    "a plain permission prompt still says what it wants",
  );
});

test("hooks: outside a workspace, or on junk input, nothing is written", () => {
  assert.equal(record({ hook_event_name: "Stop", cwd: os.tmpdir() }), null);
  const dir = workspace("i-junk", null);
  assert.equal(record({ hook_event_name: "SubagentStop", cwd: dir }), null);
  assert.equal(readAgentState(dir), null);
});

// SW-182: the liveness record idle-stop and the resume nudge read, not Claude's session files.
const { readSessions } = await import("./dist/agent_state.js");

test("hooks: each session id gets a busy/idle record beside the state; SessionEnd drops it", () => {
  const dir = workspace("i-sessions", null);
  const fire = (event, session_id, now) =>
    record({ hook_event_name: event, cwd: dir, session_id }, now);
  const t0 = new Date("2026-10-29T10:00:00Z");
  const t1 = new Date("2026-10-29T10:05:00Z");

  fire("SessionStart", "a", t0);
  assert.deepEqual(readSessions(dir), { a: { status: "idle", at: t0.toISOString() } });
  assert.equal(readAgentState(dir), null, "a session start alone is no agent state");
  fire("UserPromptSubmit", "a", t1);
  assert.equal(fire("PreToolUse", "a", new Date()), null, "still busy: no rewrite");
  fire("PreToolUse", "b", t1);
  assert.deepEqual(readSessions(dir), {
    a: { status: "busy", at: t1.toISOString() },
    b: { status: "busy", at: t1.toISOString() },
  });
  assert.deepEqual(readAgentState(dir), { state: "working", at: t1.toISOString() });

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

// SW-70: while `paused.json` exists the same hook holds the session.
const { flagNeedsYou, pauseGate, PAUSED_REASON, writePaused, writeNudge } = await import(
  "./dist/agent_state.js"
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
  const before = JSON.stringify({ state: "done", at: "2026-10-22T09:00:00.000Z" });
  write(path.join(dir, ".werkmeister", "agent-state.json"), before);
  writePaused(dir, { at: "2026-10-22T10:00:00.000Z", containers: [], was_working: false });
  assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd }).continue, false);
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", cwd }).decision, "block");
  assert.equal(
    fs.readFileSync(path.join(dir, ".werkmeister", "agent-state.json"), "utf8"),
    before,
    "a blocked call must not read as working",
  );
});

test("pause gate: an unblocked prompt clears a stale resume nudge", () => {
  const dir = workspace("l-nudge", null);
  writeNudge(dir, "continue");
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", cwd: dir }), null);
  assert.equal(fs.existsSync(path.join(dir, ".werkmeister", "resume-nudge.json")), false);
  assert.equal(readAgentState(dir).state, "working");
});

test("wake nudge: kept needs-you until the session's next hook delivers it, once (SW-418)", () => {
  const dir = workspace("l-wake", null);
  const file = path.join(dir, ".werkmeister", "wake-nudge-s-1.json");
  const fire = (e, extra = {}) =>
    hook({ hook_event_name: e, cwd: dir, session_id: "s-1", ...extra });
  write(file, JSON.stringify({ message: "PR 9 conflicts with main, resolve it." }));
  flagNeedsYou(dir, "waiting for your open session: PR 9 conflicts");
  assert.equal(fire("PreToolUse", { tool_name: "Bash" }), null);
  assert.equal(readAgentState(dir).state, "needs-you", "its own activity doesn't erase the flag");
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
  assert.equal(readAgentState(dir).state, "working");
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

// SW-189: Codex has no Notification; its approval prompt is PermissionRequest.
test("PermissionRequest marks needs-you with the tool's description, else the tool name", async () => {
  const { nextState } = await import("./dist/agent_state.js");
  const ask = (tool_input) =>
    nextState({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input }, null);
  assert.deepEqual(ask({ command: "rm -rf x", description: "Delete x" }), {
    state: "needs-you",
    question: "Delete x",
  });
  assert.deepEqual(ask({ command: "rm -rf x", description: null }), {
    state: "needs-you",
    question: "Approve Bash?",
  });
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
