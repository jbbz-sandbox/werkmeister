// SW-1097: the `metrics-trends` series. Fixture usage.json rows and events over three ISO weeks
// and two versions (plus one with none) give hand-computed buckets, percentiles, per-model totals
// and the byVersion split; the loader reads only the temp HOME.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { recordEvent } from "../dist/metrics.js";
import { metricsTrends, trendSeries } from "../dist/metrics_report.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const NOW = new Date("2026-11-20T12:00:00.000Z"); // Friday of the ISO week starting 2026-11-16
const ev = (at, event, workspace, extra = {}) => ({ v: 1, at, event, workspace, ...extra });
const tok = (input, output, cacheCreation, cacheRead) => ({
  input,
  output,
  cacheCreation,
  cacheRead,
});
const usage = (workspace, version, outcome, firstTurn, closedAt, more) => ({
  schema: 1,
  workspace,
  ticket: null,
  outcome,
  werkmeister: { version, commit: null },
  firstTurn,
  closedAt,
  turns: 1,
  ...more,
});

const USAGES = [
  // Week 1 (2026-11-02): closed Sunday 23:59Z, the last minute of its week.
  usage("ws-1", "1.4.0", "shipped", "2026-11-02T08:00:00Z", "2026-11-08T23:59:00Z", {
    totals: tok(150, 15, 0, 300),
    estUsd: 1.5,
    byModel: [
      { model: "opus", totals: tok(100, 10, 0, 300), estUsd: 1 },
      { model: "haiku", totals: tok(50, 5, 0, 0), estUsd: 0.5 },
    ],
    activeMinutes: 30,
    wallClockMinutes: 100,
    stages: [
      { stage: "01_research", finishedAt: "2026-11-02T10:00:00Z", minutes: 120 },
      { stage: "02_spec", finishedAt: "2026-11-03T10:00:00Z", minutes: 60 },
    ],
  }),
  // Closed Monday 00:00Z: week 2. Its stages finished in week 1; an unfinished one is skipped.
  usage("ws-2", "1.4.0", "shipped", "2026-11-04T08:00:00Z", "2026-11-09T00:00:00Z", {
    totals: tok(200, 20, 100, 100),
    estUsd: 2,
    byModel: [{ model: "opus", totals: tok(200, 20, 100, 100), estUsd: 2 }],
    activeMinutes: 40,
    wallClockMinutes: 7000,
    stages: [
      { stage: "01_research", finishedAt: "2026-11-04T12:00:00Z", minutes: 240 },
      { stage: "02_spec", finishedAt: "2026-11-05T12:00:00Z", minutes: 30 },
      { stage: "03_implement", finishedAt: null, minutes: null },
    ],
  }),
  // Week 3: an abandoned run on 1.5.0 with no cost, and a shipped one with no version.
  usage("ws-3", "1.5.0", "abandoned", "2026-11-16T08:00:00Z", "2026-11-17T12:00:00Z", {
    totals: tok(10, 1, 0, 0),
    estUsd: null,
    byModel: [{ model: "opus", totals: tok(10, 1, 0, 0), estUsd: null }],
    activeMinutes: 5,
    wallClockMinutes: 10,
    stages: [],
  }),
  usage("ws-4", null, "shipped", "2026-11-16T09:00:00Z", "2026-11-18T12:00:00Z", {
    totals: tok(10, 0, 0, 0),
    estUsd: 0.25,
    byModel: [],
    activeMinutes: 1,
    wallClockMinutes: 2,
    stages: [{ stage: "01_research", finishedAt: "2026-11-16T11:00:00Z", minutes: 120 }],
  }),
];

const EVENTS = [
  // ws-1: a capacity retry (exit 75, not a gate run), then a 10-minute pass.
  ev("2026-11-03T10:00:00Z", "gate.start", "ws-1", { run: "g1", retry: 0 }),
  ev("2026-11-03T10:02:00Z", "gate.end", "ws-1", { run: "g1", exit: 75 }),
  ev("2026-11-03T11:00:00Z", "gate.start", "ws-1", { run: "g2", retry: 1 }),
  ev("2026-11-03T11:10:00Z", "gate.end", "ws-1", { run: "g2", exit: 0 }),
  ev("2026-11-05T12:00:00Z", "pr.merged", "ws-1", { pr: "p1" }), // 4560 min after its first turn
  ev("2026-11-10T08:00:00Z", "release", "ws-1", { pr: "p1", tag: "v1" }), // 11520 min
  // ws-2: its first finished run fails (20 min), the second passes (30 min).
  ev("2026-11-06T10:00:00Z", "gate.start", "ws-2", { run: "g3", retry: 0 }),
  ev("2026-11-06T10:20:00Z", "gate.end", "ws-2", { run: "g3", exit: 1 }),
  ev("2026-11-06T11:00:00Z", "gate.start", "ws-2", { run: "g4", retry: 1 }),
  ev("2026-11-06T11:30:00Z", "gate.end", "ws-2", { run: "g4", exit: 0 }),
  ev("2026-11-08T08:00:00Z", "pr.merged", "ws-2", { pr: "p2" }), // 5760 min
  ev("2026-11-08T08:00:00Z", "pr.merged", "ws-2", { pr: "p2" }), // a doubled line counts once
  ev("2026-11-10T08:00:00Z", "release", "ws-2", { pr: "p2", tag: "v1" }), // 8640 min
  // ws-4: one 5-minute pass, merged, never released.
  ev("2026-11-17T09:00:00Z", "gate.start", "ws-4", { run: "g5", retry: 0 }),
  ev("2026-11-17T09:05:00Z", "gate.end", "ws-4", { run: "g5", exit: 0 }),
  ev("2026-11-18T09:00:00Z", "pr.merged", "ws-4", { pr: "p4" }), // 2880 min
];

const INPUT = { events: EVENTS, open: [], usages: USAGES };
const none = { p50Minutes: null, p90Minutes: null, count: 0 };
const NO_ROWS = { setup: 0, lint: 0, test: 0, release: 0, checks: 0 };
const slice = ({ bucket: _bucket, byVersion: _byVersion, ...rest }) => rest;

test("weeks run from the oldest item to now with no gaps; Sunday 23:59Z and Monday 00:00Z split", () => {
  const r = trendSeries(INPUT, "all", "week", NOW);
  assert.equal(r.range, "all");
  assert.equal(r.bucket, "week");
  assert.equal(r.from, null);
  assert.equal(r.to, NOW.toISOString());
  assert.deepEqual(
    r.rows.map((x) => x.bucket),
    ["2026-11-02", "2026-11-09", "2026-11-16"],
  );
  assert.deepEqual(
    r.rows.map((x) => [x.shipped, x.abandoned]),
    [
      [1, 0], // ws-1, closed Sunday 23:59Z
      [1, 0], // ws-2, closed Monday 00:00Z
      [1, 1],
    ],
  );
});

test("stage and lead-time percentiles by the bucket each one ended in", () => {
  const [w1, w2, w3] = trendSeries(INPUT, "all", "week", NOW).rows;
  const noWait = (total) => ({
    totalMinutes: total,
    personMinutes: 0,
    capacityMinutes: 0,
    workingMinutes: total,
    tokens: tok(0, 0, 0, 0),
    tokenRuns: 0,
  });
  assert.deepEqual(w1.stages, {
    "01_research": { p50Minutes: 120, p90Minutes: 240, count: 2, ...noWait(360) },
    "02_spec": { p50Minutes: 30, p90Minutes: 60, count: 2, ...noWait(90) },
  });
  assert.deepEqual(w2.stages, {}, "ws-2 closed in week 2, but its stages finished in week 1");
  assert.deepEqual(w3.stages, {
    "01_research": { p50Minutes: 120, p90Minutes: 120, count: 1, ...noWait(120) },
  });

  assert.deepEqual(w1.leadToMerge, { p50Minutes: 4560, p90Minutes: 5760, count: 2 });
  assert.deepEqual(w1.leadToRelease, none);
  assert.deepEqual(w2.leadToMerge, none);
  assert.deepEqual(w2.leadToRelease, { p50Minutes: 8640, p90Minutes: 11520, count: 2 });
  assert.deepEqual(w3.leadToMerge, { p50Minutes: 2880, p90Minutes: 2880, count: 1 });
});

test("SW-1099: each stage's minutes split into waiting on a person, on capacity and working", () => {
  const stages = [
    { stage: "01_research", finishedAt: "2026-11-16T10:00:00Z", minutes: 120 }, // 08:00–10:00
    { stage: "02_spec", finishedAt: "2026-11-16T11:00:00Z", minutes: 60 }, // 10:00–11:00
    { stage: "03_implement", finishedAt: "2026-11-16T12:00:00Z", minutes: 60 }, // 11:00–12:00
  ];
  const usages = [
    usage("ws-a", "1.5.0", "shipped", "2026-11-16T08:00:00Z", "2026-11-17T08:00:00Z", {
      ticket: "SW-1",
      stages,
    }),
    usage("ws-b", "1.4.0", "shipped", "2026-11-16T08:00:00Z", "2026-11-17T08:00:00Z", {
      stages: [stages[0]],
    }),
  ];
  const events = [
    ev("2026-11-16T09:00:00Z", "answer", "ws-a", { session: "s", waited_s: 1800 }), // 08:30–09:00
    // 10:40–11:20: 20 min in 02_spec, 20 in 03_implement.
    ev("2026-11-16T11:20:00Z", "queue.admit", "ws-a", { feature: "ws-a", waited_s: 2400 }),
    // 10:00–11:00, all of 02_spec: with the queue wait its waits pass 60 minutes, so working is 0.
    ev("2026-11-16T11:00:00Z", "answer", "ws-a", { session: "s", waited_s: 3600 }),
    ev("2026-11-16T09:30:00Z", "queue.admit", "ws-b", { feature: "ws-b", waited_s: 600 }),
  ];
  const [w] = trendSeries({ events, open: [], usages }, "all", "week", NOW).rows;
  const split = (s) => [s.totalMinutes, s.personMinutes, s.capacityMinutes, s.workingMinutes];
  assert.deepEqual(split(w.stages["01_research"]), [240, 30, 10, 200]);
  assert.deepEqual(split(w.stages["02_spec"]), [60, 60, 20, 0]);
  assert.deepEqual(split(w.stages["03_implement"]), [60, 0, 20, 40]);
  assert.deepEqual(split(w.byVersion["1.4.0"].stages["01_research"]), [120, 0, 10, 110]);
  assert.deepEqual(split(w.byVersion["1.5.0"].stages["01_research"]), [120, 30, 0, 90]);

  // Parallel sessions: overlapping waits of one cause count once; working subtracts every wait once.
  const research = (evs) =>
    split(
      trendSeries({ events: evs, open: [], usages: [usages[0]] }, "all", "week", NOW).rows[0]
        .stages["01_research"],
    );
  // 08:10–09:40 and 08:20–09:50: person 08:10–09:50, 100 min; 08:00–08:10 and 09:50–10:00 work.
  assert.deepEqual(
    research([
      ev("2026-11-16T09:40:00Z", "answer", "ws-a", { session: "s1", waited_s: 5400 }),
      ev("2026-11-16T09:50:00Z", "answer", "ws-a", { session: "s2", waited_s: 5400 }),
    ]),
    [120, 100, 0, 20],
  );
  // Two sessions both 08:10–08:40, and capacity 08:20–08:30 inside it: 30 min not working.
  assert.deepEqual(
    research([
      ev("2026-11-16T08:40:00Z", "answer", "ws-a", { session: "s1", waited_s: 1800 }),
      ev("2026-11-16T08:40:00Z", "answer", "ws-a", { session: "s2", waited_s: 1800 }),
      ev("2026-11-16T08:30:00Z", "queue.admit", "ws-a", { feature: "ws-a", waited_s: 600 }),
    ]),
    [120, 30, 10, 90],
  );
});

test("SW-1099: slowest holds up to 5 tickets, longest lead to release (else merge) first", () => {
  const usages = ["a", "b", "c", "d", "e", "f"].map((n, i) =>
    usage(`ws-${n}`, "1.5.0", "shipped", `2026-11-1${i}T00:00:00Z`, "2026-11-19T00:00:00Z", {
      ticket: n === "f" ? null : `SW-${n}`,
    }),
  );
  const events = usages.flatMap((u, i) => [
    ev("2026-11-17T00:00:00Z", "pr.merged", u.workspace, { pr: `p${i}` }),
    ...(i === 0
      ? [ev("2026-11-18T00:00:00Z", "release", u.workspace, { pr: "p0", tag: "v" })]
      : []),
  ]);
  const [w] = trendSeries({ events, open: [], usages }, "all", "week", NOW).rows.slice(-1);
  assert.deepEqual(
    w.slowest.map((t) => [t.ticket, t.leadToMergeMinutes, t.leadToReleaseMinutes]),
    [
      ["SW-a", 10080, 11520], // released: ranked by its release lead
      ["SW-b", 8640, null],
      ["SW-c", 7200, null],
      ["SW-d", 5760, null],
      ["SW-e", 4320, null],
    ],
  );
  assert.equal(w.byVersion["1.5.0"].slowest.length, 5);
});

test("tokens and cost in total and per model, cache-read share and minutes by close-out", () => {
  const [w1, w2, w3] = trendSeries(INPUT, "all", "week", NOW).rows;
  assert.deepEqual(w1.tokens, tok(150, 15, 0, 300));
  assert.equal(w1.estUsd, 1.5);
  assert.equal(w1.costUnknown, 0);
  assert.deepEqual(w1.byModel, {
    opus: { tokens: tok(100, 10, 0, 300), estUsd: 1 },
    haiku: { tokens: tok(50, 5, 0, 0), estUsd: 0.5 },
  });
  assert.equal(w1.cacheReadShare, 300 / 450);
  assert.deepEqual([w1.activeMinutes, w1.wallClockMinutes], [30, 100]);

  assert.equal(w2.cacheReadShare, 0.25);
  assert.deepEqual([w2.activeMinutes, w2.wallClockMinutes], [40, 7000]);

  assert.equal(w3.estUsd, 0.25, "ws-3 has no estimate");
  assert.equal(w3.costUnknown, 1);
  assert.deepEqual(w3.byModel, { opus: { tokens: tok(10, 1, 0, 0), estUsd: null } });
  assert.deepEqual(w3.tokens, tok(20, 1, 0, 0));
});

test("SW-1100: stage tokens, tokens after the stages, per-ticket cost, the costliest tickets and abandoned spend", () => {
  const run = (workspace, ticket, outcome, totals, estUsd, more = {}) =>
    usage(workspace, "1.4.0", outcome, "2026-11-16T08:00:00Z", "2026-11-18T12:00:00Z", {
      ticket,
      totals,
      estUsd,
      byModel: [],
      activeMinutes: 1,
      wallClockMinutes: 1,
      stages: [],
      ...more,
    });
  const usages = [
    run("a-1", "SW-1", "shipped", tok(10, 0, 0, 0), 1, {
      stages: [
        {
          stage: "01_research",
          finishedAt: "2026-11-16T10:00:00Z",
          minutes: 120,
          tokens: tok(4, 0, 0, 0),
        },
        {
          stage: "02_spec",
          finishedAt: "2026-11-16T11:00:00Z",
          minutes: 60,
          tokens: tok(5, 0, 0, 0),
        },
      ],
      unstagedTokens: tok(1, 0, 0, 0),
    }),
    // A second workspace of SW-1 sums into its ticket; a stage from before SW-1100 has no tokens.
    run("a-2", "SW-1", "shipped", tok(30, 0, 0, 0), 2, {
      stages: [{ stage: "01_research", finishedAt: "2026-11-16T12:00:00Z", minutes: 60 }],
    }),
    run("b", "SW-2", "shipped", tok(100, 0, 0, 0), 5),
    // SW-2's second workspace has no price: the ticket counts as unpriced, not as $5.
    run("b-2", "SW-2", "shipped", tok(0, 0, 0, 0), null),
    run("c", "SW-3", "shipped", tok(70, 0, 0, 0), null),
    ...["d", "e", "f", "g"].map((w, i) =>
      run(w, `SW-${10 + i}`, "shipped", tok(1, 0, 0, 0), 0.1 * (i + 1)),
    ),
    run("x", "SW-9", "abandoned", tok(50, 0, 0, 7), 4),
    run("y", null, "abandoned", tok(5, 0, 0, 0), null),
  ];
  const [w] = trendSeries({ events: [], open: [], usages }, "7d", "week", NOW).rows.slice(-1);

  assert.deepEqual(
    [w.stages["01_research"].tokens, w.stages["01_research"].tokenRuns],
    [tok(4, 0, 0, 0), 1],
  );
  assert.deepEqual(w.stages["02_spec"].tokens, tok(5, 0, 0, 0));
  assert.deepEqual(w.unstagedTokens, tok(1, 0, 0, 0));

  // Tickets: SW-1 40 tokens $3, SW-2 100 $5 but partly unpriced, SW-3 70 unpriced, SW-10..13 1 token each $0.1..$0.4.
  assert.deepEqual(w.perTicket, {
    tickets: 7,
    p50Tokens: 1,
    p90Tokens: 100,
    p50Usd: 0.30000000000000004,
    p90Usd: 3,
    unpriced: 2,
  });
  assert.deepEqual(
    w.costliest.map((t) => [t.ticket, t.workspaces, t.tokens, t.estUsd]),
    [
      ["SW-2", ["b", "b-2"], 100, 5],
      ["SW-1", ["a-1", "a-2"], 40, 3],
      ["SW-13", ["g"], 1, 0.4],
      ["SW-12", ["f"], 1, 0.30000000000000004],
      ["SW-11", ["e"], 1, 0.2],
    ],
    "highest cost first, at most 5; abandoned work is not a shipped ticket",
  );
  assert.deepEqual(w.abandonedSpend, {
    workspaces: 2,
    tokens: tok(55, 0, 0, 7),
    estUsd: 4,
    costUnknown: 1,
  });
});

test("gate runs and minutes leave out exit 75; first-pass rate is each workspace's first finished run", () => {
  const [w1, w2, w3] = trendSeries(INPUT, "all", "week", NOW).rows;
  assert.deepEqual(w1.gate, {
    runs: 3,
    wallMinutes: 60,
    firstPassRate: 0.5,
    passed: 1,
    workspaces: 2,
    byKind: NO_ROWS,
  });
  assert.deepEqual(w2.gate, {
    runs: 0,
    wallMinutes: 0,
    firstPassRate: null,
    passed: 0,
    workspaces: 0,
    byKind: NO_ROWS,
  });
  assert.deepEqual(w3.gate, {
    runs: 1,
    wallMinutes: 5,
    firstPassRate: 1,
    passed: 1,
    workspaces: 1,
    byKind: NO_ROWS,
  });
});

test("byVersion splits each row by its workspaces' usage.json version, unknown with none", () => {
  const [w1, w2, w3] = trendSeries(INPUT, "all", "week", NOW).rows;
  assert.deepEqual(Object.keys(w1.byVersion), ["1.4.0"]);
  assert.deepEqual(w1.byVersion["1.4.0"], slice(w1), "one version: the slice is the row");
  assert.deepEqual(Object.keys(w2.byVersion), ["1.4.0"]);
  assert.deepEqual(Object.keys(w3.byVersion).sort(), ["1.5.0", "unknown"]);
  const v15 = w3.byVersion["1.5.0"];
  const unknown = w3.byVersion.unknown;
  assert.deepEqual([v15.shipped, v15.abandoned, v15.estUsd, v15.costUnknown], [0, 1, null, 1]);
  assert.deepEqual([unknown.shipped, unknown.abandoned, unknown.estUsd], [1, 0, 0.25]);
  assert.equal(unknown.gate.runs, 1);
  assert.equal(unknown.leadToMerge.count, 1);
  assert.deepEqual(unknown.stages, w3.stages);
  for (const k of ["shipped", "abandoned", "costUnknown", "activeMinutes", "wallClockMinutes"])
    assert.equal(v15[k] + unknown[k], w3[k], k);
});

test("day buckets over 7d cover every date from the range's start to now; nothing logged, no rows", () => {
  const r = trendSeries(INPUT, "7d", "day", NOW);
  assert.equal(r.from, "2026-11-13T00:00:00.000Z");
  assert.deepEqual(
    r.rows.map((x) => x.bucket),
    [
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ],
  );
  const d17 = r.rows.find((x) => x.bucket === "2026-11-17");
  assert.deepEqual([d17.abandoned, d17.gate.runs], [1, 1]);
  assert.deepEqual(trendSeries({ events: [], open: [], usages: [] }, "all", "week", NOW).rows, []);
});

test("the first bucket counts from its start, before now − range; the Sunday before stays out", () => {
  // 30d before NOW is Wednesday 2026-10-21 12:00Z; its week starts Monday 2026-10-19.
  const usages = [
    usage("ws-mon", "1.4.0", "shipped", "2026-10-19T07:00:00Z", "2026-10-19T08:00:00Z", {}),
    usage("ws-sun", "1.4.0", "shipped", "2026-10-18T07:00:00Z", "2026-10-18T23:59:00Z", {}),
  ];
  const r = trendSeries({ events: [], open: [], usages }, "30d", "week", NOW);
  assert.equal(r.from, "2026-10-19T00:00:00.000Z");
  assert.equal(r.rows[0].bucket, "2026-10-19");
  assert.equal(r.rows[0].shipped, 1);
  assert.equal(
    r.rows.reduce((a, x) => a + x.shipped, 0),
    1,
  );
});

test("every row has the same fields, test minutes per package (SW-1101) among them", () => {
  for (const row of trendSeries(INPUT, "all", "week", NOW).rows)
    assert.deepEqual(Object.keys(row).sort(), [
      "abandoned",
      "abandonedSpend",
      "activeMinutes",
      "bucket",
      "byModel",
      "byVersion",
      "cacheReadShare",
      "costUnknown",
      "costliest",
      "estUsd",
      "gate",
      "leadToMerge",
      "leadToRelease",
      "perTicket",
      "shipped",
      "slowest",
      "stages",
      "tests",
      "tokens",
      "unstagedTokens",
      "wallClockMinutes",
    ]);
});

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR)$/.test(k)),
    ), // a caller's GIT_DIR beats cwd (SW-520)
    encoding: "utf8",
  });

test("metricsTrends reads the log, a workspace folder and a local record branch under the temp HOME", async () => {
  await withSandboxHome(
    async () => {
      const ws = path.join(os.homedir(), "ws");
      const closed = path.join(ws, "ws-3");
      fs.mkdirSync(closed, { recursive: true });
      fs.writeFileSync(path.join(closed, "closeout.md"), "closed\n");
      fs.writeFileSync(path.join(closed, "usage.json"), JSON.stringify(USAGES[2]));

      const repo = path.join(os.homedir(), "repos", "sandbox-workspace");
      fs.mkdirSync(repo, { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      fs.writeFileSync(path.join(repo, "README.md"), "x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      git(repo, "checkout", "-q", "-b", "me/ws-4", "main");
      fs.writeFileSync(path.join(repo, "usage.json"), JSON.stringify(USAGES[3]));
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "usage");
      assert.ok(
        recordEvent(
          { event: "pr.merged", workspace: "ws-4", pr: "p4" },
          "2026-11-18T09:00:00.000Z",
        ),
      );

      const r = await metricsTrends({ range: "all" }, NOW);
      assert.equal(r.bucket, "week");
      const w3 = r.rows.at(-1);
      assert.equal(w3.bucket, "2026-11-16");
      assert.deepEqual(
        [w3.shipped, w3.abandoned],
        [1, 1],
        "ws-4 from its branch, ws-3 from its folder",
      );
      assert.deepEqual(w3.leadToMerge, { p50Minutes: 2880, p90Minutes: 2880, count: 1 });
      assert.deepEqual(Object.keys(w3.byVersion).sort(), ["1.5.0", "unknown"]);
      assert.equal((await metricsTrends({}, NOW)).range, "30d");
    },
    { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" },
  );
});

// SW-1101: gate.row minutes by kind, and test minutes per package from test.run (else a test row).
test("gate rows sum by kind and test runs give per-package weekly p50/p90, cached and exit-75 runs left out", () => {
  const row = (at, run, r, ms, more = {}) =>
    ev(at, "gate.row", "ws-g", { run, row: r, duration_ms: ms, result: "ok", ...more });
  const task = (at, run, pkg, ms, more = {}) =>
    ev(at, "test.run", "ws-g", {
      run,
      row: "test core",
      package: pkg,
      task: "test:coverage",
      duration_ms: ms,
      result: "ok",
      cached: false,
      ...more,
    });
  const events = [
    // Run g1, week 2026-11-16: a test row with turbo tasks, and an old line with no row_kind.
    row("2026-11-17T10:00:00Z", "g1", "start core", 60_000, { row_kind: "setup" }),
    row("2026-11-17T10:01:00Z", "g1", "lint", 30_000),
    row("2026-11-17T10:05:00Z", "g1", "test core", 240_000, { row_kind: "test" }),
    task("2026-11-17T10:05:00Z", "g1", "pkg-a", 60_000),
    task("2026-11-17T10:05:00Z", "g1", "pkg-a", 180_000),
    task("2026-11-17T10:05:00Z", "g1", "pkg-a", 120_000),
    task("2026-11-17T10:05:00Z", "g1", "pkg-a", 15, { cached: true }),
    task("2026-11-17T10:05:00Z", "g1", "pkg-a", 90_000, { result: "error" }),
    ev("2026-11-17T10:05:00Z", "test.run", "ws-g", {
      run: "g1",
      row: "test core",
      package: "pkg-a",
      task: "build",
      duration_ms: 999_999,
      result: "ok",
      cached: false,
    }),
    // A test row whose turbo run held only a build (its tests ran outside turbo): its own time stands in;
    // a skipped (sub-second) one doesn't.
    ev("2026-11-17T10:07:00Z", "test.run", "ws-g", {
      run: "g1",
      row: "test web",
      package: "web",
      task: "build",
      duration_ms: 5000,
      result: "ok",
      cached: false,
    }),
    row("2026-11-17T10:07:00Z", "g1", "test web", 120_000, { row_kind: "test" }),
    row("2026-11-17T10:07:01Z", "g1", "test docs", 20, { row_kind: "test" }),
    // Run g2 ended 75: a capacity retry, none of its rows or tasks count.
    row("2026-11-18T10:00:00Z", "g2", "start core", 600_000, { row_kind: "setup" }),
    task("2026-11-18T10:00:00Z", "g2", "pkg-a", 600_000),
    ev("2026-11-18T10:10:00Z", "gate.end", "ws-g", { run: "g2", exit: 75 }),
  ];
  const r = trendSeries({ events, open: [], usages: [] }, "all", "week", NOW);
  const [w] = r.rows.slice(-1);
  assert.equal(w.bucket, "2026-11-16");
  assert.deepEqual(w.gate.byKind, { setup: 1, lint: 0.5, test: 6, release: 0, checks: 0 });
  assert.deepEqual(w.tests, {
    "pkg-a": { p50Minutes: 1.5, p90Minutes: 3, count: 4, cached: 1, failed: 1 },
    web: { p50Minutes: 2, p90Minutes: 2, count: 1, cached: 0, failed: 0 },
  });
  assert.deepEqual(r.suites["pkg-a"], { p50Minutes: 1.5, p90Minutes: 3, count: 4 });
  assert.deepEqual(Object.keys(r.suitesByVersion), ["unknown"]);
  assert.deepEqual(w.byVersion.unknown.tests["pkg-a"].count, 4);
});
