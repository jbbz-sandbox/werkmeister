// SW-487: the workspace state model — phase, activity and needs-you — from hand-built facts.

import assert from "node:assert/strict";
import { test } from "node:test";

const { workspaceState, prNeeds, legacyAgent } = await import("./dist/workspace_state.js");
const { SESSION_GONE_MS } = await import("./dist/agent_state.js");

const NOW = new Date("2026-11-06T12:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

/** Facts for a quiet building workspace; each test overrides what it is about. */
const facts = (over = {}) => ({
  now: NOW,
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
  ...over,
});
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
    "Queued for CPU · position 2",
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

test("legacyAgent: Needs you whenever the list has an item, else the session signal", () => {
  const signal = { agent: "working", at: ago(MIN), question: null };
  const gate = workspaceState(facts({ gates: [{ file: "stages/a/output/x.md", at: ago(MIN) }] }));
  assert.deepEqual(legacyAgent(gate, signal), {
    agent: "needs-you",
    at: ago(MIN),
    question: "Approve stages/a/output/x.md",
  });
  assert.deepEqual(legacyAgent(workspaceState(facts()), signal), signal);
  const paused = workspaceState(
    facts({ paused: { at: ago(MIN) }, gates: [{ file: "x", at: ago(MIN) }] }),
  );
  assert.deepEqual(legacyAgent(paused, signal), signal, "Paused replaces the badge, as before");
});
