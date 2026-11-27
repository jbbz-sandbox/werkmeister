// SW-782: the Flow tab. The `metrics` report from synthetic events → the board's four columns, card
// text, the red card past its column's p90, the timeline's bars and the #flow and #metrics tabs. No network, no DOM.
//   npm run build && node test/flow-board.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  cardView,
  formatMinutes,
  timelineView,
  COLUMN_LABEL,
  WAIT_KEYS,
  waitBars,
  cyclePoints,
  flowTiles,
  formatCount,
  agentBars,
  timeGoesBars,
  workTypeFill,
} = await import(path.join(pkgRoot, "dist/lib/flow-board.js"));
const { stackedBarView } = await import(path.join(pkgRoot, "dist/lib/charts.js"));
const { TABS, isTab, parseHash } = await import(path.join(pkgRoot, "dist/lib/tabs.js"));
const { flowMetrics } = await import("werkmeister-core/metrics_report");

const NOW = new Date("2026-11-20T12:00:00.000Z");
const ev = (at, event, workspace, extra = {}) => ({ v: 1, at, event, workspace, ...extra });
const PR = (n) => `https://github.com/o/app/pull/${n}`;
const open = (o) => ({
  ticket: null,
  stage: null,
  firstTurn: null,
  prFileAt: null,
  askAt: null,
  waitingSince: null,
  ...o,
});

// ws-done's closed run gives working a 60-min p90 (ws-slow: 6 h); ws-rel's merged PR gives pr-open 120.
const report = flowMetrics(
  {
    events: [
      ev("2026-11-19T09:00:00Z", "gate.start", "ws-done", { run: "d1", retry: 0 }),
      ev("2026-11-20T09:00:00Z", "pr.open", "ws-pr", { pr: PR(1) }),
      ev("2026-11-20T08:00:00Z", "pr.open", "ws-rel", { pr: PR(2) }),
      ev("2026-11-20T10:00:00Z", "pr.merged", "ws-rel", { pr: PR(2) }),
    ],
    open: [
      open({
        workspace: "ws-slow",
        ticket: "SW-1",
        lifecycle: "working",
        stage: { index: 3, total: 4, name: "implement" },
        firstTurn: "2026-11-20T06:00:00Z",
        askAt: "2026-11-20T11:18:00Z",
      }),
      open({ workspace: "ws-ready", lifecycle: "ready", prFileAt: "2026-11-20T11:00:00Z" }),
      open({ workspace: "ws-pr", lifecycle: "pr-open", firstTurn: "2026-11-20T07:00:00Z" }),
      open({ workspace: "ws-rel", lifecycle: "merged" }),
    ],
    usages: [
      {
        workspace: "ws-done",
        ticket: null,
        closedAt: "2026-11-19T12:00:00Z",
        firstTurn: "2026-11-19T08:00:00Z",
        estUsd: null,
        totals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        activeMinutes: 0,
        wallClockMinutes: 0,
        turns: 0,
      },
    ],
  },
  "7d",
  NOW,
);

// 1. Four columns in order, each with its WIP count.
assert.deepEqual(
  report.board.map((c) => [COLUMN_LABEL[c.column], c.wip]),
  [
    ["Working", 1],
    ["Ready", 1],
    ["PR open", 1],
    ["Awaiting release", 1],
  ],
);
console.log("✓ four columns with WIP");

// 2. The working card: stage chip, age, wait badge, red past the column's p90.
const working = report.board[0];
assert.equal(working.p90Minutes, 60, "ws-done's working visit: 08:00 → 09:00");
assert.deepEqual(cardView(working.cards[0]), {
  title: "SW-1",
  stage: "03 implement",
  age: "6h 0m",
  badge: "on you · 42 min",
  red: true,
  pooled: true, // no run has a type, so the pooled p90
});
const pr = cardView(report.board[2].cards[0]);
assert.equal(pr.title, "ws-pr", "no ticket → the workspace name");
assert.equal(pr.stage, null, "only working cards carry a stage");
assert.equal(pr.badge, "PR/CI · 180 min");
assert.equal(report.board[2].p90Minutes, 120, "ws-rel's finished PR visit: 08:00 → 10:00");
assert.equal(pr.red, true, "180 min open is past that p90");
assert.equal(cardView(report.board[1].cards[0]).red, false, "ready has no past visits, so no p90");
console.log("✓ cardView");

// 3. formatMinutes edges.
assert.equal(formatMinutes(null), "—");
assert.equal(formatMinutes(59), "59m");
assert.equal(formatMinutes(60), "1h 0m");
assert.equal(formatMinutes(1440), "1d 0h");
console.log("✓ formatMinutes");

// 4. The timeline: a stage bar, a wait block, a failed gate run, PR points, an open gate run.
const tl = timelineView(
  [
    { at: "2026-11-20T08:00:00Z", event: "answer", waitedS: 600 },
    { at: "2026-11-20T09:00:00Z", event: "stage.done", stage: "01_research" },
    { at: "2026-11-20T09:10:00Z", event: "gate.start" },
    { at: "2026-11-20T09:20:00Z", event: "gate.end", exit: 1 },
    { at: "2026-11-20T09:30:00Z", event: "pr.open", pr: PR(1) },
    { at: "2026-11-20T11:00:00Z", event: "gate.start" },
  ],
  NOW,
);
const at = (s) => Date.parse(s);
assert.deepEqual(
  tl.bars.map((b) => [b.kind, b.label, (b.to - b.from) / 60000, b.fail ?? false]),
  [
    ["wait", "on you", 10, false],
    ["stage", "01_research", 60, false],
    ["gate", "gate fail", 10, true],
    ["pr", "pr.open", 0, false],
    ["gate", "gate running", 60, false],
  ],
);
assert.equal(
  tl.start,
  at("2026-11-20T07:50:00Z"),
  "starts at the wait's start, before the first event",
);
assert.equal(tl.end, NOW.getTime());

// A run with no PR yet: its first stage starts at `start`, the current stage, an unanswered ask and
// an admitted queue wait.
const live = timelineView(
  [
    { at: "2026-11-20T06:00:00Z", event: "start" },
    { at: "2026-11-20T07:00:00Z", event: "stage.done", stage: "01_research" },
    { at: "2026-11-20T08:00:00Z", event: "queue.wait" },
    { at: "2026-11-20T08:30:00Z", event: "queue.admit", waitedS: 1800 },
    { at: "2026-11-20T11:18:00Z", event: "ask" },
  ],
  NOW,
);
assert.deepEqual(
  live.bars.map((b) => [b.kind, b.label, (b.to - b.from) / 60000]),
  [
    ["stage", "01_research", 60],
    ["wait", "capacity", 30],
    ["stage", "current stage", 300],
    ["wait", "on you", 42],
  ],
);
console.log("✓ timelineView");

// 5. #flow is a tab after Health, and #metrics after Flow.
assert.ok(isTab("flow") && isTab("metrics") && !isTab("nope"));
// SW-1099: a Metrics slowest-ticket link opens the Flow tab on that workspace.
assert.deepEqual(parseHash("flow/seed%2Fws"), { tab: "flow", workspace: "seed/ws" });
assert.deepEqual(parseHash("flow/a/b"), { tab: "flow", workspace: "a/b" });
assert.deepEqual(parseHash("flow/%E0"), { tab: "flow", workspace: null });
assert.deepEqual(parseHash("flow"), { tab: "flow", workspace: null });
assert.deepEqual(parseHash("metrics"), { tab: "metrics", workspace: null });
assert.deepEqual(parseHash("nope/x"), { tab: "list", workspace: null });
assert.deepEqual(
  TABS.map(([t]) => t),
  ["list", "new", "prs", "health", "flow", "metrics", "links"],
);

// SW-783: the Flow charts' inputs from a report with every wait cause in one week.
{
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const r = flowMetrics(
    {
      events: [
        ev("2026-11-17T10:00:00Z", "answer", "ws-x", { session: "s", waited_s: 3600 }),
        ev("2026-11-17T11:00:00Z", "queue.admit", "ws-x", { waited_s: 1800 }),
        ev("2026-11-18T09:00:00Z", "gate.start", "ws-x", { run: "g1", retry: 0 }),
        ev("2026-11-18T09:30:00Z", "gate.end", "ws-x", { run: "g1", exit: 75 }),
        ev("2026-11-18T10:00:00Z", "pr.open", "ws-x", { ticket: "SW-9", pr: PR(9) }),
        ev("2026-11-18T12:00:00Z", "pr.merged", "ws-x", { ticket: "SW-9", pr: PR(9) }),
        ev("2026-11-18T15:00:00Z", "release", "ws-x", { ticket: "SW-9", pr: PR(9), tag: "v9" }),
      ],
      open: [
        open({
          workspace: "ws-o",
          lifecycle: "working",
          sessions: [{ firstTurn: "2026-11-20T08:00:00Z", activeMinutes: 45 }],
        }),
      ],
      usages: [
        {
          workspace: "ws-x",
          ticket: "SW-9",
          closedAt: "2026-11-19T00:00:00Z",
          firstTurn: "2026-11-17T08:00:00Z",
          estUsd: null,
          totals,
          activeMinutes: 30,
          wallClockMinutes: 60,
          turns: 4,
        },
      ],
    },
    "7d",
    NOW,
  );

  const bars = waitBars(r);
  assert.deepEqual(
    bars.map((b) => b.label),
    ["2026-11-09", "2026-11-16"],
  );
  assert.deepEqual(bars[1].values, { person: 1, capacity: 0.5, pr: 2, gateRetry: 0.5, release: 3 });
  // All five causes stack bottom-up in legend order.
  assert.deepEqual(
    stackedBarView(bars, WAIT_KEYS, 100).bars[1].segments.map((s) => s.key),
    ["person", "capacity", "pr", "gateRetry", "release"],
  );

  const cycle = cyclePoints(r);
  assert.deepEqual(cycle.points, [
    { t: Date.parse("2026-11-18T12:00:00Z"), value: 28 * 60, label: "SW-9", workType: "unknown" },
  ]);
  assert.equal(cycle.p50, r.cycle.p50Minutes);
  assert.deepEqual([cycle.x0, cycle.x1], [Date.parse(r.from), NOW.getTime()]);

  const days = agentBars(r);
  assert.equal(days.length, 8);
  assert.deepEqual(days.at(-1), { label: "2026-11-20", values: { active: 45 } });
  // A closed row with no sessions counts on its close day.
  assert.deepEqual(days.at(-2), { label: "2026-11-19", values: { active: 30 } });
}

// SW-783: the cost and agent-time tiles.
{
  const u = (o) => ({
    workspaces: 2,
    estUsd: null,
    costUnknown: 2,
    tokens: { input: 100_000, output: 50_000, cacheCreation: 250_000, cacheRead: 56_000_000 },
    cacheReadShare: 0.97,
    activeMinutes: 185,
    wallClockMinutes: 280,
    turns: 340,
    ...o,
  });
  assert.deepEqual(flowTiles(u({})), [
    { label: "Est. cost", value: "—", sub: "2 workspaces closed · 2 unpriced" },
    { label: "Tokens", value: "56.4M", sub: "97% cache-read" },
    { label: "Active / wall", value: "3h 5m / 4h 40m", sub: "66% active" },
    { label: "Turns", value: "340", sub: "2 workspaces closed" },
  ]);
  assert.equal(flowTiles(u({ estUsd: 4.2, costUnknown: 0, workspaces: 1 }))[0].value, "$4.20");
  assert.equal(flowTiles(u({ workspaces: 1 }))[3].sub, "1 workspace closed");
  const none = flowTiles(
    u({
      workspaces: 0,
      costUnknown: 0,
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cacheReadShare: null,
      activeMinutes: 0,
      wallClockMinutes: 0,
      turns: 0,
    }),
  );
  assert.deepEqual(
    none.map((t) => [t.value, t.sub]),
    [
      ["—", "0 workspaces closed"],
      ["—", undefined],
      ["—", undefined],
      ["—", "0 workspaces closed"],
    ],
  );
  assert.deepEqual([940, 812_000, 999_499, 999_500, 56_400_000].map(formatCount), [
    "940",
    "812k",
    "999k",
    "1.0M",
    "56.4M",
  ]);
}
// SW-1212: the "where the time goes" bars read byWorkType as is; the scatter colours by type.
{
  const col = (column, p50, p90, count) => ({ column, p50Minutes: p50, p90Minutes: p90, count });
  const slice = (runs, fewRuns, columns, sum) => ({
    runs,
    fewRuns,
    columns,
    sumOfMediansMinutes: sum,
  });
  const bars = timeGoesBars({
    byWorkType: {
      bugfix: slice(
        6,
        false,
        [
          col("working", 40, 60, 6),
          col("ready", 5, 9, 6),
          col("pr-open", 10, 30, 6),
          col("awaiting-release", null, null, 0),
        ],
        55,
      ),
      spike: slice(
        2,
        true,
        [
          col("working", 100, 110, 2),
          col("ready", 5, 5, 2),
          col("pr-open", 30, 30, 2),
          col("awaiting-release", 60, 60, 1),
        ],
        195,
      ),
      unknown: slice(0, true, [col("working", 20, 20, 1)], 20), // no finished run: no bar
    },
  });
  assert.deepEqual(
    bars.map((b) => [b.label, b.n, b.faded, b.sumOfMedians]),
    [
      ["bugfix", 6, false, 55],
      ["spike", 2, true, 195],
    ],
  );
  assert.deepEqual(bars[0].values, { working: 40, ready: 5, "pr-open": 10, "awaiting-release": 0 });
  assert.deepEqual(bars[1].tips["awaiting-release"], { p50: 60, p90: 60, count: 1 });
  assert.equal(workTypeFill("bugfix"), "var(--sd-ok)");
  assert.equal(workTypeFill("my-workflow"), "var(--sd-faint)");
  assert.notEqual(workTypeFill("feature"), "var(--sd-err)", "red stays the past-p90 ring");
  console.log("✓ timeGoesBars, workTypeFill");
}
console.log("flow-board smoke: OK");
