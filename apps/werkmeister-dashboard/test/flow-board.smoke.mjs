// SW-782: the Flow tab. The `metrics` report from synthetic events → the board's four columns, card
// text, the red card past its column's p90, the timeline's bars and the #flow and #metrics tabs. No network, no DOM.
//   npm run build && node test/flow-board.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { cardView, formatMinutes, timelineView, COLUMN_LABEL } = await import(
  path.join(pkgRoot, "dist/lib/flow-board.js")
);
const { TABS, isTab } = await import(path.join(pkgRoot, "dist/lib/tabs.js"));
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
assert.deepEqual(
  TABS.map(([t]) => t),
  ["list", "new", "prs", "health", "flow", "metrics", "links"],
);
console.log("flow-board smoke: OK");
