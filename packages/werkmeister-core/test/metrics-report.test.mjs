// SW-781: the `metrics` report. A fixture event log gives the § Definitions numbers for each
// wait cause, the board, cycle/lead and the rollups; the loader reads only the temp HOME.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { metricsPath, recordEvent } from "../dist/metrics.js";
import { flowMetrics, metricsReport } from "../dist/metrics_report.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const NOW = new Date("2026-11-20T12:00:00.000Z"); // a Friday: its ISO week starts 2026-11-16
const ev = (at, event, workspace, extra = {}) => ({ v: 1, at, event, workspace, ...extra });
const PR = (n) => `https://github.com/o/app/pull/${n}`;

const EVENTS = [
  // ws-a: closed, first turn 08:00 on 11-16.
  ev("2026-11-15T12:00:00Z", "answer", "ws-a", { session: "s", waited_s: 99999 }), // before its first turn: a reused name's earlier run
  ev("2026-11-16T09:00:00Z", "answer", "ws-a", { session: "s", waited_s: 600 }),
  ev("2026-11-16T09:30:00Z", "queue.admit", "ws-a", { feature: "a", waited_s: 300 }),
  ev("2026-11-16T10:00:00Z", "gate.start", "ws-a", { run: "a1", retry: 0 }),
  ev("2026-11-16T10:02:00Z", "gate.end", "ws-a", { run: "a1", exit: 75 }),
  ev("2026-11-16T10:05:00Z", "gate.start", "ws-a", { run: "a2", retry: 1 }),
  ev("2026-11-16T10:06:00Z", "gate.end", "ws-a", { run: "a2", exit: 75 }),
  ev("2026-11-16T10:10:00Z", "gate.start", "ws-a", { run: "a3", retry: 2 }),
  ev("2026-11-16T10:11:30Z", "gate.end", "ws-a", { run: "a3", exit: 0 }),
  ev("2026-11-16T10:15:00Z", "pr.open", "ws-a", { ticket: "SW-1", pr: PR(1) }),
  ev("2026-11-16T10:45:00Z", "pr.merged", "ws-a", { ticket: "SW-1", pr: PR(1) }),
  ev("2026-11-16T11:45:00Z", "release", "ws-a", { ticket: "SW-1", pr: PR(1), tag: "v1" }),
  // ws-b: closed, first turn 08:00 on 11-17; its first finished gate run fails (exit 1, not a wait).
  ev("2026-11-17T10:00:00Z", "gate.start", "ws-b", { run: "b1", retry: 0 }),
  ev("2026-11-17T10:05:00Z", "gate.end", "ws-b", { run: "b1", exit: 1 }),
  ev("2026-11-17T10:20:00Z", "gate.start", "ws-b", { run: "b2", retry: 1 }),
  ev("2026-11-17T10:25:00Z", "gate.end", "ws-b", { run: "b2", exit: 0 }),
  ev("2026-11-17T11:00:00Z", "pr.open", "ws-b", { pr: PR(2) }),
  ev("2026-11-17T12:00:00Z", "pr.merged", "ws-b", { pr: PR(2) }), // no release: no tag
  // ws-old: ten days back, outside 7d.
  ev("2026-11-10T12:00:00Z", "answer", "ws-old", { session: "o", waited_s: 1000 }),
  // Open cards.
  ev("2026-11-19T12:00:00Z", "pr.open", "ws-c", { pr: PR(3) }),
  ev("2026-11-20T09:00:00Z", "pr.open", "ws-e", { pr: PR(5) }),
  ev("2026-11-20T10:00:00Z", "pr.merged", "ws-e", { pr: PR(5) }),
];

const card = (o) => ({
  ticket: null,
  stage: null,
  firstTurn: null,
  prFileAt: null,
  askAt: null,
  waitingSince: null,
  ...o,
});
const OPEN = [
  card({
    workspace: "ws-c",
    lifecycle: "pr-open",
    firstTurn: "2026-11-18T00:00:00Z",
    askAt: "2026-11-20T11:00:00Z",
  }),
  card({
    workspace: "ws-d",
    lifecycle: "ready",
    prFileAt: "2026-11-20T11:30:00Z",
    waitingSince: "2026-11-20T11:50:00Z",
  }),
  card({ workspace: "ws-e", lifecycle: "merged" }),
  card({
    workspace: "ws-f",
    ticket: "SW-6",
    lifecycle: "working",
    stage: { index: 2, total: 4, name: "spec" },
    firstTurn: "2026-11-20T06:00:00Z",
  }),
];

const usage = (workspace, closedAt, firstTurn, estUsd, totals, activeMinutes, wall, turns) => ({
  workspace,
  ticket: null,
  closedAt,
  firstTurn,
  estUsd,
  totals,
  activeMinutes,
  wallClockMinutes: wall,
  turns,
});
const USAGES = [
  usage(
    "ws-a",
    "2026-11-16T12:00:00Z",
    "2026-11-16T08:00:00Z",
    1.5,
    { input: 100, output: 50, cacheCreation: 100, cacheRead: 800 },
    30,
    240,
    10,
  ),
  usage(
    "ws-b",
    "2026-11-17T13:00:00Z",
    "2026-11-17T08:00:00Z",
    null,
    { input: 10, output: 5, cacheCreation: 0, cacheRead: 90 },
    20,
    300,
    4,
  ),
  usage(
    "ws-old",
    "2026-10-01T00:00:00Z",
    null,
    9,
    { input: 1, output: 1, cacheCreation: 1, cacheRead: 1 },
    1,
    1,
    1,
  ),
];

const report = (range) => flowMetrics({ events: EVENTS, open: OPEN, usages: USAGES }, range, NOW);
const zero = { person: 0, capacity: 0, pr: 0, gateRetry: 0, release: 0 };

test("each wait cause sums by § Definitions, in the week its wait ended", () => {
  const r = report("7d");
  // person 600 (not the pre-first-turn 99999); capacity 300; pr 30+60+60 min; gate retries 120+60 s
  // (exit 75 only, not ws-b's exit 1); release 60 min.
  const week = { person: 600, capacity: 300, pr: 9000, gateRetry: 180, release: 3600 };
  assert.deepEqual(r.waits, week);
  assert.deepEqual(r.waitsByWeek, [
    { week: "2026-11-09", seconds: zero },
    { week: "2026-11-16", seconds: week },
  ]);
  assert.equal(r.from, "2026-11-13T12:00:00.000Z");
  assert.equal(r.to, NOW.toISOString());
});

test("the range keeps only waits that ended inside it, with no week gaps", () => {
  assert.equal(report("7d").waits.person, 600);
  const month = report("30d");
  assert.equal(month.waits.person, 1600);
  assert.deepEqual(
    month.waitsByWeek.map((w) => w.week),
    ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"],
  );
  assert.equal(month.waitsByWeek[3].seconds.person, 1000);
  const all = report("all");
  assert.equal(all.from, null);
  assert.equal(all.waits.person, 1600);
  assert.deepEqual(
    all.waitsByWeek.map((w) => w.week),
    ["2026-11-09", "2026-11-16"],
  );
});

test("cycle runs first turn → merge, lead first turn → release, or → merge with no tag", () => {
  const r = report("7d");
  assert.deepEqual(r.tickets, [
    {
      ticket: "SW-1",
      workspace: "ws-a",
      firstTurn: "2026-11-16T08:00:00Z",
      mergedAt: "2026-11-16T10:45:00Z",
      releasedAt: "2026-11-16T11:45:00Z",
      cycleMinutes: 165,
      leadMinutes: 225,
    },
    {
      ticket: "ws-b",
      workspace: "ws-b",
      firstTurn: "2026-11-17T08:00:00Z",
      mergedAt: "2026-11-17T12:00:00Z",
      releasedAt: null,
      cycleMinutes: 240,
      leadMinutes: 240,
    },
  ]);
  assert.deepEqual(r.cycle, { p50Minutes: 165, p90Minutes: 240 });
  assert.deepEqual(r.lead, { p50Minutes: 225, p90Minutes: 240 });
});

test("gate first-pass rate counts each workspace's first run that finished (exit ≠ 75)", () => {
  assert.deepEqual(report("7d").gate, { firstPassRate: 0.5, passed: 1, workspaces: 2 });
  assert.deepEqual(flowMetrics({ events: [], open: [], usages: [] }, "7d", NOW).gate, {
    firstPassRate: null,
    passed: 0,
    workspaces: 0,
  });
});

test("the board: four columns, age against each column's past p50/p90, one wait per card", () => {
  const r = report("7d");
  assert.deepEqual(
    r.board.map((c) => [c.column, c.wip, c.p50Minutes, c.p90Minutes]),
    [
      ["working", 1, 120, 120], // ws-a, ws-b: first turn → first gate.start
      ["ready", 1, 15, 60], // first gate.start → first pr.open
      ["pr-open", 1, 60, 60], // ws-a 30, ws-b 60, ws-e 60 (ws-e is past pr-open)
      ["awaiting-release", 1, 60, 60], // ws-a merge → release; ws-e is still in it
    ],
  );
  const [working, ready, prOpen, awaiting] = r.board.map((c) => c.cards[0]);
  assert.deepEqual(working, {
    workspace: "ws-f",
    ticket: "SW-6",
    stage: { index: 2, total: 4, name: "spec" },
    enteredAt: "2026-11-20T06:00:00Z",
    ageMinutes: 360,
    overP90: true,
    wait: null,
  });
  // No gate run yet: entered ready at the PR-file edit; capacity is its only wait.
  assert.equal(ready.enteredAt, "2026-11-20T11:30:00Z");
  assert.deepEqual(ready.wait, { cause: "capacity", since: "2026-11-20T11:50:00Z", minutes: 10 });
  // A person's open ask outranks the PR wait.
  assert.equal(prOpen.ageMinutes, 1440);
  assert.equal(prOpen.overP90, true);
  assert.deepEqual(prOpen.wait, { cause: "person", since: "2026-11-20T11:00:00Z", minutes: 60 });
  assert.equal(awaiting.workspace, "ws-e");
  assert.deepEqual(awaiting.wait, {
    cause: "release",
    since: "2026-11-20T10:00:00Z",
    minutes: 120,
  });
  assert.equal(awaiting.overP90, true);
});

test("usage sums the snapshots closed in the range", () => {
  assert.deepEqual(report("7d").usage, {
    workspaces: 2,
    estUsd: 1.5,
    costUnknown: 1,
    tokens: { input: 110, output: 55, cacheCreation: 100, cacheRead: 890 },
    cacheReadShare: 890 / 1100,
    activeMinutes: 50,
    wallClockMinutes: 540,
    turns: 14,
  });
  assert.equal(report("all").usage.workspaces, 3);
});

const NO_TOKENS = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

test("a reused name open again drops only the old run's events, even with its transcripts pruned", () => {
  const r = flowMetrics(
    {
      events: [
        ev("2026-10-31T00:00:00Z", "pr.open", "ws-r", { pr: PR(7) }), // the closed run
        ev("2026-11-19T00:00:00Z", "pr.open", "ws-r", { pr: PR(8) }), // this run, before its oldest transcript left
      ],
      open: [card({ workspace: "ws-r", lifecycle: "pr-open", firstTurn: "2026-11-19T06:00:00Z" })],
      usages: [
        usage("ws-r", "2026-11-01T00:00:00Z", "2026-10-30T00:00:00Z", 1, NO_TOKENS, 0, 0, 0),
      ],
    },
    "7d",
    NOW,
  );
  assert.equal(r.board[2].cards[0].enteredAt, "2026-11-19T00:00:00Z");
});

// SW-997: a racing `pr watch` and `pr status` can write one pr.* / release line twice.
const LIFECYCLE = [
  ev("2026-11-18T10:00:00Z", "pr.open", "ws-d", { pr: PR(20) }),
  ev("2026-11-18T10:30:00Z", "pr.merged", "ws-d", { pr: PR(20) }),
  ev("2026-11-18T11:30:00Z", "release", "ws-d", { pr: PR(20), tag: "v2" }),
];
const waitsOf = (events) => flowMetrics({ events, open: [], usages: [] }, "all", NOW).waits;

test("identical pr.open, pr.merged and release lines count once", () => {
  const once = waitsOf(LIFECYCLE);
  assert.deepEqual([once.pr, once.release], [1800, 3600]);
  assert.deepEqual(waitsOf([...LIFECYCLE, ...LIFECYCLE]), once);
});

test("distinct PRs and other events are not collapsed", () => {
  const other = [
    ev("2026-11-18T10:00:00Z", "pr.open", "ws-f", { pr: PR(21) }),
    ev("2026-11-18T10:10:00Z", "pr.merged", "ws-f", { pr: PR(21) }),
  ];
  assert.equal(waitsOf([...LIFECYCLE, ...other]).pr, 1800 + 600);
  const answer = ev("2026-11-18T09:00:00Z", "answer", "ws-d", { session: "s", waited_s: 60 });
  assert.equal(waitsOf([answer, { ...answer }]).person, 120);
});

test("metricsReport counts a doubled pr.merged line in the temp-HOME log once", async () => {
  await withSandboxHome(
    async (home) => {
      const file = metricsPath(LIFECYCLE[0].at);
      assert.ok(file.startsWith(`${home}${path.sep}`), file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const lines = [...LIFECYCLE, LIFECYCLE[1]].map((e) => JSON.stringify(e)).join("\n");
      fs.writeFileSync(file, `${lines}\n`);
      fs.mkdirSync(path.join(os.homedir(), "ws"), { recursive: true });
      assert.equal((await metricsReport({ range: "all" }, NOW)).waits.pr, 1800);
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
    cwd,
    encoding: "utf8",
  });

test("metricsReport reads the log, workspace folders and local record branches under the temp HOME", async () => {
  await withSandboxHome(
    async (home) => {
      const at = "2026-11-20T10:00:00.000Z";
      assert.ok(metricsPath(at).startsWith(`${home}${path.sep}`), metricsPath(at));
      assert.ok(recordEvent({ event: "pr.open", workspace: "ws-open", pr: PR(9) }, at));

      const ws = path.join(os.homedir(), "ws");
      const open = path.join(ws, "ws-open");
      fs.mkdirSync(path.join(open, ".werkmeister"), { recursive: true });
      fs.writeFileSync(path.join(open, ".werkmeister", "workspace.yml"), "issue_id: SW-9\n");
      fs.mkdirSync(path.join(open, "stages", "04_propose", "output"), { recursive: true });
      fs.writeFileSync(
        path.join(open, "stages", "04_propose", "output", "pr-app.md"),
        `---\nrepo: o/app\nbranch: me/ws-open\nbase: main\nstatus: open\nurl: ${PR(9)}\n---\n# feat\n`,
      );
      // An open ask, and a crashed busy record that readSessions would delete: this tool only reads.
      const sessions = path.join(open, ".werkmeister", "sessions");
      fs.mkdirSync(sessions);
      const askAt = "2026-11-20T11:00:00.000Z";
      fs.writeFileSync(
        path.join(sessions, "s1.json"),
        JSON.stringify({
          status: "idle",
          at: askAt,
          ask: { kind: "question", what: "?", at: askAt, source: "session" },
        }),
      );
      const stale = path.join(sessions, "s2.json");
      fs.writeFileSync(stale, JSON.stringify({ status: "busy", at: "2026-11-01T00:00:00.000Z" }));
      const closedUsage = {
        schema: 1,
        workspace: "ws-closed",
        ticket: "SW-8",
        closedAt: "2026-11-19T00:00:00.000Z",
        firstTurn: null,
        estUsd: 2,
        totals: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
        activeMinutes: 5,
        wallClockMinutes: 10,
        turns: 3,
      };
      const closed = path.join(ws, "ws-closed");
      fs.mkdirSync(closed, { recursive: true });
      fs.writeFileSync(path.join(closed, "closeout.md"), "closed\n");
      fs.writeFileSync(path.join(closed, "usage.json"), JSON.stringify(closedUsage));

      // The shared checkout: main has no usage.json; ws-closed's branch duplicates the folder copy.
      const repo = path.join(os.homedir(), "repos", "sandbox-workspace");
      fs.mkdirSync(repo, { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      fs.writeFileSync(path.join(repo, "README.md"), "x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      for (const u of [closedUsage, { ...closedUsage, workspace: "ws-gone", estUsd: 3 }]) {
        git(repo, "checkout", "-q", "-b", `me/${u.workspace}`, "main");
        fs.writeFileSync(path.join(repo, "usage.json"), `${JSON.stringify(u, null, 2)}\n`);
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "usage");
      }

      const r = await metricsReport({ range: "all" }, NOW);
      const prOpen = r.board.find((c) => c.column === "pr-open");
      assert.equal(prOpen.wip, 1);
      assert.equal(prOpen.cards[0].workspace, "ws-open");
      assert.equal(prOpen.cards[0].ticket, "SW-9");
      assert.equal(prOpen.cards[0].enteredAt, at);
      assert.deepEqual(prOpen.cards[0].wait, { cause: "person", since: askAt, minutes: 60 });
      assert.ok(fs.existsSync(stale), "a read never deletes a session record");
      assert.equal(r.usage.workspaces, 2, "ws-closed once, plus ws-gone from its branch");
      assert.equal(r.usage.estUsd, 5);
      assert.equal((await metricsReport({}, NOW)).range, "7d");
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});
