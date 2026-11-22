// SW-487: the workspace state model — phase, activity and needs-you — from hand-built facts.

import assert from "node:assert/strict";
import { test } from "node:test";

const { workspaceState, prNeeds } = await import("../dist/workspace_state.js");
const { SESSION_GONE_MS } = await import("../dist/agent_state.js");

const NOW = new Date("2026-11-06T12:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

/** Facts for a quiet building workspace; each test overrides what it is about. */
const facts = (over = {}) => ({
  now: NOW,
  signal: { agent: "idle", at: null },
  sessions: {},
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
  ...over,
});
/** The model's agent word for facts *over* and the session *signal*. */
const chip = (over, signal) => workspaceState(facts({ ...over, signal })).agent;
const kinds = (s) => s.needs.map((n) => n.kind);
const busy = (over = {}) => ({ status: "busy", at: ago(MIN), last: ago(MIN), ...over });

test("phase: each lifecycle state, with the stage while building", () => {
  const phase = (over) => workspaceState(facts(over)).phase;
  assert.deepEqual(phase({ stage: { index: 2, total: 4, name: "spec" } }), {
    id: "building",
    label: "Stage 2 of 4 · spec",
    stage: "Stage 2 of 4 · spec",
  });
  assert.equal(phase({ jitPhase: "test" }).label, "JIT · test");
  assert.equal(phase({ lifecycle: "ready" }).id, "building");
  assert.equal(phase({ lifecycle: "pr-open" }).id, "pr-open");
  assert.equal(phase({ lifecycle: "merged" }).label, "Merged, waiting for release");
  assert.equal(phase({ lifecycle: "shipped" }).id, "released");
  assert.equal(phase({ lifecycle: "shipped", postmortemAt: ago(MIN) }).id, "ready-to-close");
  assert.equal(phase({ lifecycle: "abandoned" }).id, "abandoned");
  assert.equal(phase({ lifecycle: "abandoned", postmortemAt: ago(MIN) }).id, "ready-to-close");
  assert.equal(phase({ lifecycle: "closed-out", closedOut: true }).id, "closed");
});

test("activity: first match wins, in the order paused → queued → starting → testing → tool → subagent → thinking → gone → idle", () => {
  const act = (over) => workspaceState(facts(over)).activity;
  const testing = busy({
    tool: { name: "Bash", command: "werkmeister pr gate --tests", at: ago(MIN) },
  });
  assert.equal(act({ paused: { at: ago(MIN) }, sessions: { s: testing } }).id, "paused");
  assert.equal(
    act({ waiting: { position: 2, reason: "" }, sessions: { s: testing } }).label,
    "Queued for capacity (position 2)",
  );
  // SW-569: a service start waiting on capacity holds only that start, so the live session shows.
  assert.equal(
    act({ waiting: { position: 2, reason: "", services: ["api"] }, sessions: { s: testing } }).id,
    "testing",
  );
  assert.equal(
    act({ services: [{ name: "api", state: "starting" }], sessions: { s: testing } }).id,
    "starting",
  );
  const tool = busy({ tool: { name: "Edit", at: ago(MIN) } });
  assert.deepEqual(act({ sessions: { a: tool, b: testing } }), {
    id: "testing",
    label: "Running tests",
    since: ago(MIN),
    session: "b",
  });
  for (const command of [
    "pnpm turbo run typecheck test",
    "docker exec x sh -c 'node --test a.mjs'",
    "pytest -q",
  ])
    assert.equal(
      act({ sessions: { s: busy({ tool: { name: "Bash", command, at: ago(MIN) } }) } }).id,
      "testing",
      command,
    );
  assert.equal(
    act({ sessions: { s: busy({ tool: { name: "Bash", command: "git status", at: ago(MIN) } }) } })
      .id,
    "tool",
  );
  assert.equal(act({ sessions: { a: tool } }).label, "Running Edit");
  assert.equal(act({ sessions: { a: busy({ subagents: 2 }) } }).id, "subagent");
  const idleParent = { status: "idle", at: ago(MIN), last: ago(MIN), stopped: true, subagents: 1 };
  assert.equal(
    act({ sessions: { a: idleParent } }).id,
    "subagent",
    "a background agent outlives the turn",
  );
  assert.equal(
    act({ sessions: { a: { ...idleParent, last: ago(SESSION_GONE_MS + MIN) } } }).id,
    "idle",
    "a stale count doesn't stick",
  );
  assert.equal(act({ sessions: { a: busy() } }).id, "thinking");
  assert.equal(act({ turnRunning: true }).id, "thinking");
  assert.equal(
    act({ sessions: { a: { status: "idle", at: ago(MIN), stopped: true } } }).id,
    "idle",
  );
  assert.equal(act({}).id, "idle");
});

test("activity: a busy session silent past the limit is gone unless its process is still open", () => {
  const act = (ms, processOpen) =>
    workspaceState(facts({ sessions: { s: busy({ at: ago(ms), last: ago(ms) }) }, processOpen }))
      .activity.id;
  assert.equal(act(SESSION_GONE_MS - MIN, null), "thinking", "29 min: a long quiet turn");
  assert.equal(act(SESSION_GONE_MS + MIN, null), "gone", "31 min, probe can't tell");
  assert.equal(act(SESSION_GONE_MS + MIN, false), "gone");
  assert.equal(act(SESSION_GONE_MS + MIN, true), "thinking", "a long test run in an open session");
});

test("needs-you: one item per session ask, with what, since, action and source", () => {
  const ask = (kind, source = "session") => ({ kind, what: `${kind}?`, at: ago(5 * MIN), source });
  const s = workspaceState(
    facts({
      sessions: {
        a: { status: "idle", at: ago(MIN), ask: ask("question") },
        b: busy({ ask: ask("permission") }),
        c: busy({ ask: ask("plan") }),
        d: { status: "idle", at: ago(MIN), stopped: true, ask: ask("question", "text") },
      },
    }),
  );
  assert.deepEqual(s.needs[0], {
    id: "question:a",
    kind: "question",
    what: "question?",
    since: ago(5 * MIN),
    action: "Answer it",
    source: "session",
    session: "a",
  });
  assert.deepEqual(kinds(s), ["question", "permission", "plan", "question"]);
  assert.equal(s.needs[3].source, "text", "the reply-text guess says so");
  assert.equal(s.needs[2].action, "Approve the plan");
});

test("needs-you: the transcript guess only when no session has a record; paused hides session asks", () => {
  const transcriptAsk = { what: "Which fix?", at: ago(MIN) };
  assert.deepEqual(kinds(workspaceState(facts({ transcriptAsk }))), ["question"]);
  assert.equal(workspaceState(facts({ transcriptAsk })).needs[0].source, "text");
  assert.deepEqual(kinds(workspaceState(facts({ transcriptAsk, sessions: { s: busy() } }))), []);
  const asked = {
    s: {
      status: "idle",
      at: ago(MIN),
      ask: { kind: "question", what: "x", at: ago(MIN), source: "session" },
    },
  };
  assert.deepEqual(kinds(workspaceState(facts({ sessions: asked, paused: { at: ago(MIN) } }))), []);
});

test("needs-you: gates, lifecycle, containers, a dead session and notices", () => {
  const gate = workspaceState(
    facts({ gates: [{ file: "stages/02_spec/output/spec.md", at: ago(MIN) }] }),
  );
  assert.deepEqual(
    [gate.needs[0].kind, gate.needs[0].source, gate.needs[0].file, gate.needs[0].since],
    ["gate", "gate", "stages/02_spec/output/spec.md", ago(MIN)],
  );
  const released = workspaceState(facts({ lifecycle: "shipped", releasedAt: ago(MIN) }));
  assert.deepEqual(
    [kinds(released), released.needs[0].action],
    [["postmortem"], "Run the postmortem"],
  );
  const done = workspaceState(facts({ lifecycle: "shipped", postmortemAt: ago(MIN) }));
  assert.deepEqual([kinds(done), done.needs[0].since], [["close"], ago(MIN)]);
  const crash = workspaceState(
    facts({
      crashLoops: [{ service: "api", restarts: 4, lastLog: "boom" }],
      started: { at: ago(MIN), by: "gate" },
    }),
  );
  assert.deepEqual([kinds(crash), crash.needs[0].source], [["crash-loop"], "containers"]);
  const stale = { s: busy({ at: ago(SESSION_GONE_MS * 2), last: ago(SESSION_GONE_MS * 2) }) };
  const died = workspaceState(facts({ sessions: stale, lifecycle: "pr-open" }));
  assert.deepEqual([kinds(died), died.needs[0].session], [["session-died"], "s"]);
  assert.deepEqual(
    kinds(workspaceState(facts({ sessions: stale, lifecycle: "shipped", postmortemAt: ago(MIN) }))),
    ["close"],
    "released work is not unfinished",
  );
  const notices = workspaceState(
    facts({
      heldWakes: [{ session: "s1", at: ago(MIN) }],
      registrySync: [{ repo: "app", url: "https://x/pr/9" }],
      notices: { "autofix-app": { what: "auto-fix blocked", action: "Approve", at: ago(MIN) } },
    }),
  );
  assert.deepEqual(
    notices.needs.map((n) => [n.kind, n.source, n.id]),
    [
      ["notice", "notice", "notice:wake-s1"],
      ["notice", "notice", "notice:registry-app"],
      ["notice", "notice", "notice:autofix-app"],
    ],
  );
  assert.deepEqual(
    notices.needs.map((n) => n.dismiss),
    [undefined, undefined, "autofix-app"],
    "only a stored notice is dismissed by hand",
  );
  const merged = workspaceState(
    facts({
      lifecycle: "merged",
      notices: { "autofix-app": { what: "x", action: "y", at: ago(MIN) } },
    }),
  );
  assert.deepEqual(kinds(merged), [], "an auto-fix block on a merged PR is moot");
});

const pr = (over = {}) => ({
  repo: "app",
  branch: "me/x",
  url: "https://github.com/o/app/pull/9",
  state: "OPEN",
  title: "feat: x",
  labels: [],
  ci: "pass",
  failingChecks: 0,
  draft: false,
  mergeable: "MERGEABLE",
  review: null,
  behind: false,
  ciAt: null,
  reviewAt: null,
  ...over,
});

test("prNeeds: CI failed, conflict, changes requested, and merge only when approved, green, ready and clean", () => {
  const k = (over) => prNeeds([pr(over)]).needs.map((n) => n.kind);
  assert.deepEqual(k({ ci: "fail", failingChecks: 2, ciAt: ago(MIN) }), ["ci-failed"]);
  assert.equal(prNeeds([pr({ ci: "fail", ciAt: ago(MIN) })]).needs[0].since, ago(MIN));
  assert.deepEqual(k({ mergeable: "CONFLICTING" }), ["conflict"]);
  assert.deepEqual(k({ review: "CHANGES_REQUESTED", reviewAt: ago(MIN) }), ["changes-requested"]);
  assert.deepEqual(k({ review: "APPROVED" }), ["merge"]);
  assert.deepEqual(k({ review: "APPROVED", draft: true }), []);
  assert.deepEqual(k({ review: "APPROVED", ci: "running" }), []);
  assert.deepEqual(k({ review: "APPROVED", mergeable: "CONFLICTING" }), ["conflict"]);
  assert.deepEqual(k({ review: "APPROVED", state: "MERGED" }), [], "only open PRs need anything");
  const item = prNeeds([pr({ review: "APPROVED" })]).needs[0];
  assert.deepEqual(
    [item.source, item.url, item.action],
    ["pr", "https://github.com/o/app/pull/9", "Merge it"],
  );
});

test("prNeeds: phase detail says waiting on review and behind main", () => {
  assert.equal(prNeeds([pr()]).phaseDetail, null);
  assert.equal(prNeeds([pr({ review: "REVIEW_REQUIRED" })]).phaseDetail, "waiting on review");
  assert.equal(
    prNeeds([pr({ review: "REVIEW_REQUIRED", behind: true })]).phaseDetail,
    "waiting on review · behind main",
  );
  assert.equal(prNeeds([pr({ behind: true, state: "MERGED" })]).phaseDetail, null);
});

test("agent: Needs you whenever the list has an item, else the session signal", () => {
  const signal = { agent: "working", at: ago(MIN) };
  const gates = [{ file: "stages/a/output/x.md", at: ago(2 * MIN) }];
  assert.deepEqual(chip({ gates }, signal), { id: "needs-you", since: ago(2 * MIN) });
  assert.deepEqual(chip({}, signal), { id: "working", since: ago(MIN) });
  assert.deepEqual(
    chip({ paused: { at: ago(MIN) }, gates }, signal),
    { id: "working", since: ago(MIN) },
    "Paused replaces the badge, as before",
  );
});

// SW-570: a draft gate needs the person only once the agent has handed it over.
test("needs-you: a gate is not handed over while a background shell, a capacity wait or autonomy holds it", () => {
  const gates = [{ file: "stages/02_fix/output/fix.md", at: ago(MIN) }];
  const idle = { status: "idle", at: ago(MIN), last: ago(MIN), stopped: true };
  const shell = (command, at = ago(MIN)) => ({ s: { ...idle, shell: { command, at } } });
  const state = (over) => workspaceState(facts({ gates, ...over }));

  // sw-567: the turn ended with the gate's test run still in a background shell.
  const testing = state({ sessions: shell("werkmeister pr gate --tests") });
  assert.deepEqual(kinds(testing), []);
  assert.deepEqual([testing.activity.id, testing.activity.label], ["testing", "Running tests"]);
  const other = state({ sessions: shell("sleep 600") });
  assert.deepEqual(kinds(other), []);
  assert.deepEqual(
    [other.activity.id, other.activity.label],
    ["tool", "Running in background: sleep 600"],
  );
  assert.deepEqual(
    kinds(state({ sessions: shell("pnpm test", ago(90 * MIN + SESSION_GONE_MS + MIN)) })),
    ["gate"],
    "a shell silent past the limit doesn't stick",
  );

  // sw-563: the gate's service start waits on capacity while the session is idle.
  const queued = state({
    sessions: { s: idle },
    waiting: { position: 1, reason: "", services: ["werkmeister-vscode"] },
  });
  assert.deepEqual(kinds(queued), []);
  assert.deepEqual(
    [queued.activity.id, queued.activity.label],
    ["queued", "Queued for capacity (position 1)"],
  );
  assert.deepEqual(kinds(state({ waiting: { position: 2, reason: "" } })), []);

  // Still mid-turn: the draft isn't handed over yet.
  for (const s of [busy(), busy({ tool: { name: "Edit", at: ago(MIN) } }), busy({ subagents: 1 })])
    assert.deepEqual(kinds(state({ sessions: { s } })), []);
  assert.deepEqual(kinds(state({ services: [{ name: "api", state: "starting" }] })), []);

  // An autonomous workspace approves its own stage gates, but not its PR file (SW-771).
  assert.deepEqual(kinds(state({ autonomous: true, sessions: { s: idle } })), []);
  const prFile = [{ file: "stages/04_propose/output/pr-repo.md", at: ago(MIN) }];
  assert.deepEqual(kinds(state({ autonomous: true, gates: prFile, sessions: { s: idle } })), [
    "gate",
  ]);
  assert.deepEqual(
    kinds(state({ autonomous: true, gates: prFile, sessions: shell("pnpm test") })),
    [],
  );

  // Handed over: idle, nothing running, not autonomous.
  assert.deepEqual(kinds(state({ sessions: { s: idle } })), ["gate"]);
  assert.deepEqual(kinds(state({})), ["gate"]);
  assert.deepEqual(kinds(state({ paused: { at: ago(MIN) } })), ["gate"], "paused still lists it");
});

// SW-681: a stopped turn that left a background shell or a capacity wait read "Done" on the card,
// the VS Code badge, MCP status and the check-in sweep.
test("agent: a background shell or a capacity wait reads working, not done", () => {
  const stopped = { status: "idle", at: ago(MIN), last: ago(MIN), stopped: true };
  const done = { agent: "done", at: ago(MIN) };
  const shell = (command) => ({ s: { ...stopped, shell: { command, at: ago(MIN) } } });

  const prOpen = workspaceState(
    facts({ sessions: shell("werkmeister pr open --watch"), signal: done }),
  );
  assert.equal(prOpen.activity.label, "Running in background: pr open");
  assert.equal(prOpen.agent.id, "working");

  assert.equal(chip({ sessions: shell("werkmeister pr gate --tests") }, done).id, "working");

  for (const waiting of [
    { position: 2, reason: "" },
    { position: 2, reason: "", services: ["werkmeister-core"] },
  ]) {
    const queued = workspaceState(facts({ sessions: { s: stopped }, waiting, signal: done }));
    assert.equal(queued.activity.label, "Queued for capacity (position 2)");
    assert.equal(queued.agent.id, "working");
  }

  assert.equal(chip({ sessions: { s: { ...stopped, subagents: 1 } } }, done).id, "working");
  const starting = { sessions: { s: stopped }, services: [{ name: "core", state: "starting" }] };
  assert.equal(chip(starting, done).id, "working");
  assert.deepEqual(
    chip(starting, { agent: "idle", at: ago(MIN) }),
    { id: "idle", since: ago(MIN) },
    "no session: containers starting aren't an agent at work",
  );
  const long = "until gh pr view 12 --json state; do sleep 30; done; echo merged";
  assert.equal(
    workspaceState(facts({ sessions: shell(long) })).activity.label,
    "Running in background: until gh pr view 12 --json state; do sl…",
  );
  const stale = {
    s: { ...stopped, shell: { command: "x", at: ago(90 * MIN + SESSION_GONE_MS + MIN) } },
  };
  assert.deepEqual(chip({ sessions: stale }, done), { id: "done", since: ago(MIN) });

  // Nothing left running: done stays done.
  assert.deepEqual(chip({ sessions: { s: stopped } }, done), { id: "done", since: ago(MIN) });
});

// SW-690: every code worktree is named `werkmeister`, so a path or an argument read as a subcommand.
test("activity: a background command names werkmeister only at a segment start, and its second word only for a command group", () => {
  const stopped = { status: "idle", at: ago(MIN), last: ago(MIN), stopped: true };
  const label = (command) =>
    workspaceState(facts({ sessions: { s: { ...stopped, shell: { command, at: ago(MIN) } } } }))
      .activity.label;
  assert.equal(
    label("git -C werkmeister log --oneline -5"),
    "Running in background: git -C werkmeister log --oneline -5",
  );
  assert.equal(label("werkmeister up sw-681"), "Running in background: up");
  assert.equal(label("cd ws && werkmeister pr open --watch"), "Running in background: pr open");
  assert.equal(label("werkmeister feature up"), "Running in background: feature up");
});

// SW-558: the card's one-word agent is part of the model; no surface reads `claude.agent`.
test("agent: Needs you whenever the list has an item, working while the activity is, else the session signal", () => {
  const stopped = { status: "idle", at: ago(MIN), last: ago(MIN), stopped: true };
  const done = { agent: "done", at: ago(MIN), question: null };
  const gate = workspaceState(
    facts({ signal: done, sessions: { s: stopped }, gates: [{ file: "a.md", at: ago(2 * MIN) }] }),
  );
  assert.deepEqual(gate.agent, { id: "needs-you", since: ago(2 * MIN) });
  const shell = { s: { ...stopped, shell: { command: "werkmeister pr open", at: ago(MIN) } } };
  assert.equal(workspaceState(facts({ signal: done, sessions: shell })).agent.id, "working");
  assert.deepEqual(workspaceState(facts({ signal: done, sessions: { s: stopped } })).agent, {
    id: "done",
    since: ago(MIN),
  });
});

// SW-953: the chip and the activity line agreed only for a done signal; an idle one stayed Idle beside "Thinking".
test("agent: an idle signal reads working while a session or background agent works", async () => {
  const { agentOf } = await import("../dist/agent_state.js");
  // sw-852: a turn busy for 6 h, no hook event for 40 min, its process still open.
  const quiet = { status: "busy", at: ago(6 * 60 * MIN), last: ago(40 * MIN) };
  const sessions = { s: quiet };
  const signal = { agent: agentOf(sessions, NOW.getTime())?.agent ?? "idle", at: quiet.at };
  const st = workspaceState(facts({ sessions, signal, processOpen: true }));
  assert.equal(st.activity.label, "Thinking");
  assert.equal(st.activity.since, quiet.last, "last heard, not the turn's start");
  assert.equal(st.agent.id, "working", "Idle beside Thinking");
  for (const tool of [
    { name: "Read", at: ago(MIN) },
    { name: "Bash", command: "pnpm test", at: ago(MIN) },
  ])
    assert.equal(
      chip({ sessions: { s: busy({ tool }) } }, { agent: "idle", at: null }).id,
      "working",
    );

  // Background agents after the parent's turn, before its Stop: no done signal to promote.
  const bg = { s: { status: "idle", at: ago(MIN), last: ago(MIN), subagents: 5 } };
  const idle = { agent: "idle", at: ago(MIN) };
  assert.equal(workspaceState(facts({ sessions: bg, signal: idle })).activity.id, "subagent");
  assert.equal(chip({ sessions: bg }, idle).id, "working", "Idle beside Background agent running");
});

// SW-1007: stalled = working with no session write, a capacity wait, or a crash; each limit is "older than".
test("stalled: each rule, its 30 min boundary, and need-you apart", () => {
  const stalled = (over) => workspaceState(facts(over)).stalled;
  const working = { agent: "working", at: ago(MIN) };
  const LIMIT = 30 * MIN;
  for (const [ms, want] of [
    [LIMIT - 1, null],
    [LIMIT, null],
    [LIMIT + 1, "idle"],
  ])
    assert.equal(
      stalled({ signal: working, lastActivity: ago(ms) })?.reason ?? null,
      want,
      `idle ${ms}`,
    );
  assert.deepEqual(stalled({ signal: working, lastActivity: ago(LIMIT + 1) }), {
    reason: "idle",
    since: ago(LIMIT + 1),
  });
  assert.equal(stalled({ lastActivity: ago(2 * LIMIT) }), null, "not working");
  assert.equal(stalled({ signal: working, lastActivity: null }), null, "no activity known");

  const waiting = (ms) => ({ position: 1, reason: "budget", since: ago(ms) });
  for (const [ms, want] of [
    [LIMIT - 1, null],
    [LIMIT, null],
    [LIMIT + 1, "capacity-wait"],
  ])
    assert.equal(stalled({ waiting: waiting(ms) })?.reason ?? null, want, `wait ${ms}`);
  assert.equal(stalled({ waiting: { position: 1, reason: "budget" } }), null, "no since");
  const done = { agent: "done", at: ago(LIMIT + 1) };
  assert.equal(
    stalled({ signal: done, lastActivity: ago(LIMIT + 1), waiting: waiting(LIMIT + 1) })?.reason,
    "capacity-wait",
    "queued reads working but is not idle",
  );
  assert.equal(
    stalled({ signal: done, lastActivity: ago(LIMIT + 1), waiting: waiting(MIN) }),
    null,
    "a short queue wait over a quiet transcript",
  );

  const crash = stalled({ crashLoops: [{ service: "api", restarts: 4, lastLog: "boom" }] });
  assert.equal(crash?.reason, "crash-loop");
  const stale = { s: busy({ at: ago(SESSION_GONE_MS * 2), last: ago(SESSION_GONE_MS * 2) }) };
  assert.equal(stalled({ sessions: stale, lifecycle: "pr-open" })?.reason, "session-died");

  const asked = (at) => ({
    status: "idle",
    at,
    ask: { kind: "question", what: "?", at, source: "session" },
  });
  const one = workspaceState(facts({ sessions: { a: asked(ago(2 * LIMIT)) } }));
  assert.deepEqual([one.stalled, one.oldestNeedMs], [null, 2 * LIMIT], "need-you is not stalled");
  const two = workspaceState(facts({ sessions: { a: asked(ago(MIN)), b: asked(ago(5 * MIN)) } }));
  assert.equal(two.oldestNeedMs, 5 * MIN);
  assert.equal(workspaceState(facts()).oldestNeedMs, null);
});

test("stalled: stalledAfter overrides both 30 min limits", () => {
  const stalledAfter = { idleMs: 10 * MIN, waitMs: 5 * MIN };
  const stalled = (over) =>
    workspaceState(facts({ stalledAfter, ...over })).stalled?.reason ?? null;
  const working = { agent: "working", at: ago(MIN) };
  assert.equal(stalled({ signal: working, lastActivity: ago(10 * MIN) }), null);
  assert.equal(stalled({ signal: working, lastActivity: ago(10 * MIN + 1) }), "idle");
  const waiting = (ms) => ({ position: 1, reason: "budget", since: ago(ms) });
  assert.equal(stalled({ waiting: waiting(5 * MIN) }), null);
  assert.equal(stalled({ waiting: waiting(5 * MIN + 1) }), "capacity-wait");
  const gate = (ms) => ({
    sessions: {
      s: busy({
        at: ago(ms),
        last: ago(ms),
        tool: { name: "Bash", command: "werkmeister pr gate", at: ago(ms) },
      }),
    },
    processOpen: true,
    signal: working,
    lastActivity: ago(ms),
  });
  assert.equal(stalled(gate(20 * MIN)), null, "default toolMs beats idleMs 10");
  assert.equal(
    stalled({ ...gate(20 * MIN + 1), stalledAfter: { ...stalledAfter, toolMs: 20 * MIN } }),
    "idle",
  );
});

// SW-1037: no transcript write during one tool call, so an open tool gets the longer limit.
test("stalled: an open tool call gets the 90 min limit, not the 30 min one", () => {
  const TOOL = 90 * MIN;
  const working = { agent: "working", at: ago(MIN) };
  const st = (ms, tool) =>
    workspaceState(
      facts({
        sessions: { s: busy({ at: ago(ms), last: ago(ms), tool: { ...tool, at: ago(ms) } }) },
        processOpen: true,
        signal: working,
        lastActivity: ago(ms),
      }),
    );
  const test35 = st(35 * MIN, { name: "Bash", command: "werkmeister pr gate" });
  assert.equal(test35.activity.label, "Running tests");
  assert.equal(test35.stalled, null, "35-min test run is not stalled");
  assert.equal(st(35 * MIN, { name: "Read" }).stalled, null, "any open tool");
  assert.equal(st(TOOL, { name: "Bash", command: "pnpm test" }).stalled, null, "at the limit");
  assert.deepEqual(st(TOOL + 1, { name: "Bash", command: "pnpm test" }).stalled, {
    reason: "idle",
    since: ago(TOOL + 1),
  });
  // No tool open: the 30 min idle limit still applies.
  const thinking = workspaceState(
    facts({
      sessions: { s: busy({ at: ago(MIN), last: ago(MIN) }) },
      signal: working,
      lastActivity: ago(30 * MIN + 1),
    }),
  );
  assert.equal(thinking.activity.id, "thinking");
  assert.equal(thinking.stalled?.reason, "idle");
});

// SW-1047: a background shell outlives its turn, so it keeps the tool limit past SESSION_GONE_MS.
test("stalled: a background shell keeps reading running past 30 min and gets the tool limit", () => {
  const TOOL = 90 * MIN;
  const stopped = { status: "idle", stopped: true };
  // The transcript was last written when the shell started and the turn ended.
  const bg = (command, ms, over = {}) =>
    workspaceState(
      facts({
        sessions: {
          s: { ...stopped, at: ago(ms), last: ago(ms), shell: { command, at: ago(ms) } },
        },
        signal: { agent: "done", at: ago(ms) },
        lastActivity: ago(ms),
        ...over,
      }),
    );
  const test35 = bg("pnpm test", 35 * MIN);
  assert.deepEqual([test35.activity.id, test35.activity.label], ["testing", "Running tests"]);
  assert.equal(test35.agent.id, "working");
  assert.equal(test35.stalled, null, "35 min is under toolMs");
  assert.equal(bg("pnpm test", TOOL).stalled, null, "at the limit");
  const hung = bg("pnpm test", TOOL + MIN);
  assert.equal(hung.activity.id, "testing", "still visible once stalled");
  assert.deepEqual(hung.stalled, { reason: "idle", since: ago(TOOL + MIN) });
  // A non-test shell is a tool and gets the same limit.
  const other = bg("sleep 9000", 35 * MIN);
  assert.equal(other.activity.label, "Running in background: sleep 9000");
  assert.equal(other.stalled, null);
  assert.equal(bg("sleep 9000", TOOL + MIN).stalled?.reason, "idle");
  // Past toolMs + SESSION_GONE_MS the record is taken for a missed exit and drops out.
  const gone = bg("pnpm test", TOOL + SESSION_GONE_MS + MIN);
  assert.equal(gone.activity.id, "idle");
  assert.equal(gone.stalled, null);
  // stalledAfter.toolMs moves the window: 40 min tool limit drops out past 70.
  const stalledAfter = { idleMs: 30 * MIN, waitMs: 30 * MIN, toolMs: 40 * MIN };
  assert.equal(bg("pnpm test", 41 * MIN, { stalledAfter }).stalled?.reason, "idle");
  assert.equal(bg("pnpm test", 71 * MIN, { stalledAfter }).activity.id, "idle");
});
