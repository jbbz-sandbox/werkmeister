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
  assert.deepEqual(w1.stages, {
    "01_research": { p50Minutes: 120, p90Minutes: 240, count: 2 },
    "02_spec": { p50Minutes: 30, p90Minutes: 60, count: 2 },
  });
  assert.deepEqual(w2.stages, {}, "ws-2 closed in week 2, but its stages finished in week 1");
  assert.deepEqual(w3.stages, { "01_research": { p50Minutes: 120, p90Minutes: 120, count: 1 } });

  assert.deepEqual(w1.leadToMerge, { p50Minutes: 4560, p90Minutes: 5760, count: 2 });
  assert.deepEqual(w1.leadToRelease, none);
  assert.deepEqual(w2.leadToMerge, none);
  assert.deepEqual(w2.leadToRelease, { p50Minutes: 8640, p90Minutes: 11520, count: 2 });
  assert.deepEqual(w3.leadToMerge, { p50Minutes: 2880, p90Minutes: 2880, count: 1 });
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

test("gate runs and minutes leave out exit 75; first-pass rate is each workspace's first finished run", () => {
  const [w1, w2, w3] = trendSeries(INPUT, "all", "week", NOW).rows;
  assert.deepEqual(w1.gate, {
    runs: 3,
    wallMinutes: 60,
    firstPassRate: 0.5,
    passed: 1,
    workspaces: 2,
  });
  assert.deepEqual(w2.gate, {
    runs: 0,
    wallMinutes: 0,
    firstPassRate: null,
    passed: 0,
    workspaces: 0,
  });
  assert.deepEqual(w3.gate, {
    runs: 1,
    wallMinutes: 5,
    firstPassRate: 1,
    passed: 1,
    workspaces: 1,
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

test("no test-minutes field until SW-1101 logs test events", () => {
  for (const row of trendSeries(INPUT, "all", "week", NOW).rows)
    assert.deepEqual(Object.keys(row).sort(), [
      "abandoned",
      "activeMinutes",
      "bucket",
      "byModel",
      "byVersion",
      "cacheReadShare",
      "costUnknown",
      "estUsd",
      "gate",
      "leadToMerge",
      "leadToRelease",
      "shipped",
      "stages",
      "tokens",
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
