// The display model: one case per agent, container, service, PR and CI state
// (ui-spec § The card / § Badges / § Actions), plus the no-DOM guarantee.
// Run: npm run build && node --test test/display-model.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const { displayModel, ago, statusStrip } = await import("../dist/display-model.js");

const NOW = new Date("2026-10-20T12:00:00Z");
const minsAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

const base = {
  state: "up",
  running: 2,
  total: 2,
  services: [],
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
};
const model = (ws = {}, opts = {}) => displayModel({ ...base, ...ws }, { now: NOW, ...opts });
/** A status whose model says only the agent word (SW-558), plus the session's question when it asked one. */
const chipState = (id, since = null, question = null) => ({
  workspaceState: {
    phase: { id: "building", label: "", stage: null },
    activity: { id: "idle", label: "Idle", since: null, session: null },
    needs: question
      ? [
          {
            id: "question:s",
            kind: "question",
            what: question,
            since,
            action: "Answer it",
            source: "session",
          },
        ]
      : [],
    agent: { id, since },
  },
});
const pr = (over = {}) => ({
  url: "https://github.com/jbbz-sandbox/werkmeister/pull/231",
  state: "OPEN",
  ci: null,
  failingChecks: 0,
  ...over,
});

test("has no runtime imports, so no DOM dependency", () => {
  const js = fs.readFileSync(new URL("../dist/display-model.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /^\s*import\b/m);
  assert.doesNotMatch(js, /\b(document|window)\b/);
});

test("agent states", () => {
  const cases = {
    "needs-you": ["● Needs you", "needs", "warn", "circle-filled", "asked a question 12 min ago"],
    working: ["◌ Working", "ok", "ok", "sync", "last activity 3 min ago"],
    done: ["✓ Done", "ok", "ok", "pass", "idle since 12 min ago"],
    idle: ["Idle", "off", "off", "circle-outline", "no live turn, nothing asked"],
  };
  for (const [agent, [label, tone, dot, codicon, time]] of Object.entries(cases)) {
    const m = model({
      ...chipState(agent, minsAgo(12), agent === "needs-you" ? "ICM or JIT?" : null),
      lastActivity: minsAgo(3),
    });
    assert.deepEqual(
      [m.agent.label, m.agent.tone, m.agent.dot, m.agent.codicon, m.agent.time],
      [label, tone, dot, codicon, time],
      agent,
    );
    assert.equal(m.needs, agent === "needs-you", agent);
    assert.equal(m.question, agent === "needs-you" ? "ICM or JIT?" : null, agent);
  }
});

test("autonomous badge", () => {
  assert.equal(model().autonomous, null);
  assert.deepEqual(model({ autonomous: true }).autonomous, {
    full: "⚙ Autonomous",
    compact: "⚙ Auto",
  });
});

test("model: the workspace's model, null when it records none or the core predates SW-577", () => {
  assert.equal(model({ model: "opus" }).model, "opus");
  assert.equal(model({ model: null }).model, null);
  assert.equal(model().model, null);
});

test("container summary states", () => {
  const cases = [
    [{ state: "up", running: 2, total: 2 }, "2 of 2 up", "ok"],
    [{ state: "partial", running: 1, total: 2 }, "1 of 2 up", "warn"],
    [{ state: "stopped", running: 0, total: 2 }, "0 of 2 up", "off"],
    [{ state: "down", running: 0, total: 0 }, "down", "off"],
    [{ state: "unknown", running: 0, total: 0 }, "Docker unreachable", "off"],
  ];
  for (const [ws, text, tone] of cases) assert.deepEqual(model(ws).containers, { text, tone });
});

test("service health states", () => {
  const states = ["healthy", "running", "down", "starting", "unhealthy"];
  const m = model({ services: states.map((state) => ({ name: "cli", state })) });
  assert.deepEqual(
    m.services.map((s) => [s.text, s.tone, s.codicon]),
    [
      ["● cli", "ok", "circle-filled"],
      ["● cli", "ok", "circle-filled"],
      ["○ cli", "off", "circle-outline"],
      ["◐ cli starting", "warn", "loading"],
      ["▲ cli unhealthy", "err", "warning"],
    ],
  );
});

test("PR states", () => {
  const cases = [
    [{}, "Open", "ok", false],
    [{ draft: true }, "Draft", "off", true],
    [{ state: "MERGED" }, "Merged", "pr", false],
    [{ state: "MERGED", release: "v0.14.0" }, "Released v0.14.0", "pr", false],
    [{ state: "CLOSED" }, "Closed", "off", false],
  ];
  for (const [over, text, tone, dashed] of cases) {
    const m = model({}, { prs: [pr(over)] });
    assert.equal(m.prsEmpty, null);
    assert.equal(m.prs[0].ref, "werkmeister#231");
    assert.deepEqual(m.prs[0].state, { text, tone, dashed }, text);
  }
});

test("no PR, and a failed lookup", () => {
  assert.deepEqual(model().prsEmpty, { text: "None yet", tone: "off" });
  // a worktree with no PR (url null) is not listed
  const none = model({}, { prs: [pr({ url: null, state: null })] });
  assert.deepEqual([none.prs, none.prsEmpty], [[], { text: "None yet", tone: "off" }]);
  assert.deepEqual(model({}, { prs: null }).prsEmpty, { text: "PRs unavailable", tone: "warn" });
});

test("CI states", () => {
  const cases = [
    [{ ci: "pass" }, { text: "CI ✓", tone: "ok" }],
    [{ ci: "running" }, { text: "CI running", tone: "warn" }],
    [
      { ci: "fail", failingChecks: 2 },
      { text: "CI ✗ 2 failing", tone: "err" },
    ],
    [{ ci: null }, null],
  ];
  for (const [over, want] of cases)
    assert.deepEqual(model({}, { prs: [pr(over)] }).prs[0].ci, want);
});

test("workflow: lifecycle, ICM stage, JIT phase, none", () => {
  const stage = { index: 2, total: 4, name: "spec" };
  assert.deepEqual(model({ stage }).workflow, {
    kind: "icm",
    text: "Stage 2 of 4 · spec",
    compact: "stage 2/4 spec",
    pips: ["done", "current", "next", "next"],
  });
  assert.equal(model({ phase: "implement" }).workflow.text, "JIT · implement");
  assert.equal(model().workflow.kind, "none");
  const steps = {
    ready: "Ready to open PR",
    merged: "Awaiting release",
    shipped: "Ready to close out",
    "closed-out": "Closed out",
    abandoned: "Abandoned",
  };
  for (const [lifecycle, text] of Object.entries(steps)) {
    const { kind, text: got } = model({ stage }, { lifecycle }).workflow;
    assert.deepEqual([kind, got], ["lifecycle", text], lifecycle);
  }
  // still working, or a PR under review: the stage says more
  for (const lifecycle of ["working", "pr-open"])
    assert.equal(model({ stage }, { lifecycle }).workflow.kind, "icm", lifecycle);
});

test("primary action", () => {
  const needs = chipState("needs-you", null, "?");
  assert.deepEqual(model({ ...needs, state: "down" }, { where: "Desktop" }).primary, {
    action: "continue",
    label: "↗ Continue in Desktop",
    destructive: false,
  });
  assert.deepEqual(model({}, { lifecycle: "shipped" }).primary, {
    action: "close-out",
    label: "✓ Close out",
    destructive: true,
  });
  for (const state of ["down", "stopped"])
    assert.equal(model({ state }).primary.label, "▶ Up", state);
  assert.equal(model().primary.label, "↗ Continue in Terminal");
});

test("SW-70: paused overrides the agent state, reads paused, and offers Resume", () => {
  const d = model({
    state: "paused",
    paused: { at: minsAgo(12), containers: ["a-api"] },
    ...chipState("needs-you", minsAgo(30), "Which fix?"),
  });
  assert.equal(d.agent.label, "⏸ Paused");
  assert.equal(d.agent.tone, "off");
  assert.equal(d.agent.time, "paused 12 min ago");
  assert.equal(d.needs, false);
  assert.equal(d.question, null);
  assert.deepEqual(d.containers, { text: "paused", tone: "off" });
  assert.deepEqual(d.primary, { action: "resume", label: "▶ Resume", destructive: false });
  // A core older than SW-70 sends no `paused`: nothing changes.
  assert.equal(model({ paused: undefined }).agent.label, "Idle");
});

test("ago", () => {
  assert.equal(ago(null, NOW), "");
  assert.equal(ago(new Date(NOW.getTime() - 40_000).toISOString(), NOW), "40 s ago");
  assert.equal(ago(minsAgo(5 * 60), NOW), "5 h ago");
  assert.equal(ago(minsAgo(24 * 60), NOW), "1 day ago");
  assert.equal(ago(minsAgo(2 * 24 * 60), NOW), "2 days ago");
});

test("SW-41: a crash loop turns the containers and the service red, with the last log line", () => {
  const one = model({
    services: [
      { name: "api", state: "running" },
      { name: "web", state: "healthy" },
    ],
    crashLoops: [{ service: "api", restarts: 4, lastLog: "Error: EADDRINUSE" }],
  });
  assert.deepEqual(one.containers, { text: "api crash-looping", tone: "err" });
  assert.deepEqual(one.crash, {
    text: "✗ api crash-looping · 4 restarts · Error: EADDRINUSE",
    tone: "err",
  });
  assert.deepEqual(
    one.services.map((s) => [s.text, s.tone, s.codicon]),
    [
      ["✗ api crash-looping", "err", "error"],
      ["● web", "ok", "circle-filled"],
    ],
  );
  const two = model({
    crashLoops: [
      { service: "a", restarts: 0, lastLog: null },
      { service: "b", restarts: 2, lastLog: null },
    ],
  });
  assert.equal(two.containers.text, "2 crash-looping");
  assert.equal(two.crash.text, "✗ a crash-looping; ✗ b crash-looping · 2 restarts");
  assert.equal(model().crash, null, "no loops, no crash line");
});

test("SW-41: usage and start reason", () => {
  const d = model(
    { started: { at: minsAgo(120), by: "gate" } },
    { usage: { cpuPercent: 12.3, memMib: 410 } },
  );
  assert.deepEqual(d.usage, { text: "12.3% CPU · 410 MiB", tone: "ok" });
  assert.deepEqual(d.started, { text: "started 2 h ago by gate", tone: "off" });
  assert.equal(model({}, { usage: { cpuPercent: 140, memMib: 1 } }).usage.tone, "warn");
  const none = model();
  assert.equal(none.usage, null);
  assert.equal(none.started, null);
});

// SW-487: the core state model rendered as a Needs-you list, a phase and an activity.
const wsState = (over = {}) => ({
  phase: { id: "building", label: "Stage 2 of 4 · spec", stage: "Stage 2 of 4 · spec" },
  activity: { id: "testing", label: "Running tests", since: minsAgo(4), session: "s" },
  needs: [],
  agent: { id: "idle", since: null },
  ...over,
});
const need = (over = {}) => ({
  id: "gate:x",
  kind: "gate",
  what: "Approve stages/02_spec/output/spec.md",
  since: minsAgo(12),
  action: "Read it",
  source: "gate",
  ...over,
});

test("SW-487: needsList joins the sweep's items and the PR poll's, with since, guess and dismiss", () => {
  const m = model(
    {
      workspaceState: wsState({
        needs: [
          need(),
          need({ id: "question:s", kind: "question", what: "Ship?", source: "text" }),
          need({
            id: "notice:autofix-app",
            kind: "notice",
            source: "notice",
            dismiss: "autofix-app",
          }),
        ],
      }),
    },
    {
      prNeeds: [
        need({
          id: "merge:app",
          kind: "merge",
          what: "app PR is approved and green",
          since: null,
          source: "pr",
          url: "https://x/pr/1",
        }),
      ],
    },
  );
  assert.deepEqual(
    m.needsList.map((n) => [n.id, n.since, n.guess, n.dismiss, n.url]),
    [
      ["gate:x", "12 min ago", false, null, null],
      ["question:s", "12 min ago", true, null, null],
      ["notice:autofix-app", "12 min ago", false, "autofix-app", null],
      ["merge:app", "", false, null, "https://x/pr/1"],
    ],
  );
  assert.equal(m.needs, true, "any item lights the card");
  assert.equal(m.question, "Approve stages/02_spec/output/spec.md");
});

test("SW-487: phase and activity rows; PR detail only while a PR is open", () => {
  const m = model({ workspaceState: wsState() });
  assert.deepEqual(m.phase, { text: "Stage 2 of 4 · spec", tone: "off" });
  assert.deepEqual(m.activity, { text: "Running tests", tone: "ok", time: "4 min ago" });
  const open = model(
    { workspaceState: wsState({ phase: { id: "pr-open", label: "PR open", stage: null } }) },
    { phaseDetail: "waiting on review" },
  );
  assert.equal(open.phase.text, "PR open · waiting on review");
  const gone = model({
    workspaceState: wsState({
      activity: { id: "gone", label: "Session gone", since: minsAgo(40), session: "s" },
    }),
  });
  assert.equal(gone.activity.tone, "err");
  const old = model({});
  assert.deepEqual(
    [old.needsList, old.phase, old.activity],
    [[], null, null],
    "an older core still renders",
  );
});

test("SW-487: primary action follows the session's ask, not a gate or lifecycle item", () => {
  const released = wsState({
    needs: [need({ id: "postmortem:workspace", kind: "postmortem", source: "lifecycle" })],
  });
  assert.equal(
    model(
      { workspaceState: { ...released, agent: { id: "needs-you", since: null } } },
      { lifecycle: "shipped" },
    ).primary.action,
    "close-out",
  );
  const asked = wsState({
    needs: [need({ id: "question:s", kind: "question", source: "session" })],
  });
  assert.equal(
    model({ workspaceState: asked }, { lifecycle: "shipped" }).primary.action,
    "continue",
  );
  const paused = model({ paused: { at: minsAgo(1), containers: [] }, workspaceState: asked });
  assert.deepEqual([paused.needsList, paused.needs], [[], false], "paused: nothing is news");
});

// SW-953: one state word; the activity is its detail, never a second state.
test("SW-953: the activity line drops what the chip says, and a quiet Thinking reads dim", () => {
  const act = (id, label, since, agent = "done") =>
    model({
      workspaceState: wsState({
        activity: { id, label, since, session: "s" },
        agent: { id: agent, since: minsAgo(5) },
      }),
    });
  const done = act("idle", "Idle", null);
  assert.equal(done.agent.word, "Done");
  assert.equal(done.activity, null, "no Done beside Idle (sw-891)");
  assert.equal(act("paused", "Paused", minsAgo(2), "idle").activity, null);
  assert.equal(act("idle", "Idle", null, "idle").agent.time, "no live turn, nothing asked");

  assert.deepEqual(act("thinking", "Thinking", minsAgo(2), "working").activity, {
    text: "Thinking",
    tone: "ok",
    time: "2 min ago",
  });
  assert.deepEqual(
    act("thinking", "Thinking", minsAgo(6 * 60), "working").activity,
    { text: "Thinking", tone: "off", time: "last heard 6 h ago" },
    "a 6 h old Thinking is not styled live",
  );
  assert.equal(act("thinking", "Thinking", minsAgo(29), "working").activity.tone, "ok");
  // A long tool call keeps its live tone: the tool's start is not silence.
  assert.equal(act("tool", "Running Bash", minsAgo(6 * 60), "working").activity.tone, "ok");
});

// SW-962: VS Code's card and the dashboard's Health rows print the same line.
test("SW-962: needLine: guess, since, no since", async () => {
  const { needLine } = await import("../dist/display-model.js");
  const row = {
    id: "q",
    what: "Ship it?",
    action: "Answer it",
    since: "12 min ago",
    guess: false,
    url: null,
    dismiss: null,
  };
  assert.equal(needLine(row), "● Ship it? · 12 min ago — Answer it");
  assert.equal(needLine({ ...row, guess: true }), "● Ship it? (guess) · 12 min ago — Answer it");
  assert.equal(needLine({ ...row, since: "" }), "● Ship it? — Answer it");
});

// SW-1008: the status strip both workspaces views draw.
const row = (name, ws = {}, extra = {}) => ({
  name,
  ws: { ...base, state: "down", ...ws },
  ...extra,
});
const GiB = 1024 ** 3;
const quiet = { load: [1, 1, 1], cores: 12, featureCpuPercent: 0 };

test("SW-1008: an all-zero snapshot has no chips, only the host line", () => {
  const s = statusStrip(
    [
      row("a"),
      row("b", {
        workspaceState: wsState({
          activity: { id: "idle", label: "", since: null, session: null },
        }),
      }),
    ],
    {
      host: quiet,
      infra: { state: "up", services: [{ name: "caddy", state: "healthy" }] },
      trackerAuth: { ok: true },
    },
    NOW,
  );
  assert.deepEqual(s.chips, []);
  assert.deepEqual(s.host, {
    text: "host 8% · features 0.0 of 12 cores",
    tone: "ok",
    meter: { host: 1 / 12, features: 0 },
    tooltip: "load 1 · 5 · 15 min: 1 · 1 · 1 on 12 cores",
  });
});

test("SW-1008: a host over 100% keeps the raw percent, warns, and clamps the meter", () => {
  const s = statusStrip([], {
    host: { load: [14.6, 9.2, 8], cores: 12, featureCpuPercent: 358.4 },
    budget: { memory: 16 * GiB, cpus: null, used: { memory: 11.5 * GiB, cpus: 0 } },
  });
  assert.equal(s.host.text, "host 122% · features 3.6 of 12 cores");
  assert.equal(s.host.tone, "warn");
  assert.equal(s.host.meter.host, 1);
  assert.ok(Math.abs(s.host.meter.features - 3.584 / 12) < 1e-9);
  assert.equal(
    s.host.tooltip,
    "load 1 · 5 · 15 min: 14.6 · 9.2 · 8 on 12 cores\nmemory budget 11.5 of 16 GiB",
  );
});

test("SW-1008: no sweep yet has no host line; a failed one reads host n/a", () => {
  assert.equal(statusStrip([]).host, null);
  assert.deepEqual(statusStrip([], { host: null }).host, {
    text: "host n/a",
    tone: "off",
    meter: { host: 0, features: 0 },
    tooltip: "host load unavailable",
  });
});

test("SW-1008: every chip, in order, counting workspaces, with the first match to jump to", () => {
  const queued = { id: "queued", label: "Waiting for capacity", since: minsAgo(3), session: null };
  const rows = [
    row("quiet"),
    row("asks", {
      state: "up",
      workspaceState: wsState({
        agent: { id: "needs-you", since: minsAgo(5) },
        needs: [need({ since: minsAgo(130) })],
      }),
    }),
    row("asks2", {}, { prNeeds: [need({ id: "pr:x", since: minsAgo(20) })] }),
    row("stuck", { state: "partial" }, { stalled: true }),
    row("stuck-but-asks", {}, { stalled: true, prNeeds: [need({ id: "pr:y" })] }),
    row("queued", { workspaceState: wsState({ activity: queued }) }),
    row("red", {}, { prs: [{ url: "u", state: "OPEN", ci: "fail", failingChecks: 1 }] }),
    row(
      "conflict",
      {},
      {
        prs: [{ url: "u", state: "OPEN", ci: "pass", failingChecks: 0, mergeable: "CONFLICTING" }],
      },
    ),
    row("merged-red", {}, { prs: [{ url: "u", state: "MERGED", ci: "fail", failingChecks: 1 }] }),
  ];
  const s = statusStrip(
    rows,
    {
      host: quiet,
      infra: {
        state: "partial",
        services: [
          { name: "caddy", state: "down" },
          { name: "redis", state: "unhealthy" },
          { name: "pg", state: "running" },
        ],
      },
      trackerAuth: { ok: false, reason: "token expired" },
      budget: { memory: 16 * GiB, cpus: 8, used: { memory: 11.5 * GiB, cpus: 6 } },
    },
    NOW,
  );
  assert.deepEqual(
    s.chips.map(({ kind, count, text, tone, first }) => [kind, count, text, tone, first]),
    [
      ["needs", 3, "● 3 need you · 2 h", "needs", "asks"],
      ["stalled", 1, "1 stalled", "err", "stuck"],
      ["running", 2, "2 running", "ok", "asks"],
      ["waiting", 1, "1 waiting · 11.5 of 16 GiB · 6 of 8 CPUs", "warn", "queued"],
      ["infra", 2, "infra: caddy down, redis unhealthy", "err", null],
      ["ci", 2, "2 CI failed or conflicts", "err", "red"],
      ["auth", 1, "tracker auth expired", "warn", null],
    ],
  );
});

test("SW-1069: the infra chip names each service by its state; starting alone is warn, not down", () => {
  const chip = (...services) =>
    statusStrip([], { infra: { state: "partial", services } }).chips.map(({ text, tone }) => [
      text,
      tone,
    ])[0];
  assert.deepEqual(chip({ name: "k8s-forwards", state: "starting" }), [
    "infra: k8s-forwards starting",
    "warn",
  ]);
  assert.deepEqual(chip({ name: "caddy", state: "down" }), ["infra: caddy down", "err"]);
  assert.deepEqual(chip({ name: "redis", state: "unhealthy" }), ["infra: redis unhealthy", "err"]);
  assert.deepEqual(
    chip(
      { name: "caddy", state: "down" },
      { name: "registry", state: "healthy" },
      { name: "k8s-forwards", state: "starting" },
    ),
    ["infra: caddy down, k8s-forwards starting", "err"],
  );
  assert.equal(
    chip({ name: "caddy", state: "healthy" }, { name: "jaeger", state: "running" }),
    undefined,
  );
});

test("SW-1008: one workspace reads needs you; data a view lacks hides its chip or suffix", () => {
  const queued = { id: "queued", label: "", since: null, session: null };
  const s = statusStrip([
    row("a", {}, { prNeeds: [need({ since: null })] }),
    row("b", { workspaceState: wsState({ activity: queued }) }),
  ]);
  assert.deepEqual(
    s.chips.map((c) => c.text),
    ["● 1 needs you", "1 waiting"],
  );
  assert.equal(
    statusStrip([], { infra: { state: "unknown", services: [] } }).chips[0].text,
    "infra: docker unreachable",
  );
  assert.deepEqual(
    statusStrip([row("p", { paused: { at: minsAgo(1), containers: [] } }, { prNeeds: [need()] })])
      .chips,
    [],
  );
});

test("SW-1008: a budget limit that is no whole GiB reads to one decimal", () => {
  const queued = { id: "queued", label: "", since: null, session: null };
  const budget = { memory: 8e9, cpus: null, used: { memory: 2 * GiB, cpus: 0 } };
  const s = statusStrip([row("q", { workspaceState: wsState({ activity: queued }) })], {
    host: quiet,
    budget,
  });
  assert.equal(s.chips[0].text, "1 waiting · 2.0 of 7.5 GiB");
  assert.match(s.host.tooltip, /memory budget 2\.0 of 7\.5 GiB$/);
});
