// SW-1098: the Metrics tab's inline-SVG chart primitives (data → marks) and its view model over a
// hand-built `metrics-trends` result: versions, the empty state, tiles and preview inputs. No DOM.
//   npm run build && node test/charts.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { W, lineBandView, stackedBarView, heatmapView, scatterView, statTile, formatUsd } =
  await import(path.join(pkgRoot, "dist/lib/charts.js"));
const { RANGE_BUCKET, versionsOf, sliceRows, isEmpty, emptyText, metricsTiles, previewCharts } =
  await import(path.join(pkgRoot, "dist/lib/metrics-view.js"));

// 1. lineBandView: p50 line over a p50→p90 band, broken by a null point.
{
  const v = lineBandView(
    [
      { label: "a", p50: 10, p90: 20 },
      { label: "b", p50: 20, p90: 40 },
      { label: "c", p50: 40, p90: 50 },
    ],
    100,
  );
  assert.equal(v.yMax, 50);
  assert.equal(v.line, "M166.7 80 L500 60 L833.3 20");
  assert.equal(v.band, "M166.7 60 L500 20 L833.3 0 L833.3 20 L500 60 L166.7 80 Z");
  assert.deepEqual(
    v.dots.map((d) => [d.x, d.y]),
    [
      [166.7, 80],
      [500, 60],
      [833.3, 20],
    ],
  );
  const gap = lineBandView(
    [
      { label: "a", p50: 10, p90: 20 },
      { label: "b", p50: null, p90: null },
      { label: "c", p50: 30, p90: 50 },
    ],
    100,
  );
  assert.equal(gap.line, "M166.7 80 M833.3 40");
  assert.equal(gap.band, "M166.7 60 L166.7 80 Z M833.3 0 L833.3 40 Z");
  const none = lineBandView([{ label: "a", p50: null, p90: null }], 100);
  assert.deepEqual([none.yMax, none.line, none.band, none.dots], [1, "", "", []]);
}
console.log("✓ lineBandView");

// 2. stackedBarView: segments bottom-up in key order, zeros left out, tallest bar reaches the top.
{
  const v = stackedBarView(
    [
      { label: "w1", values: { shipped: 3, abandoned: 1 } },
      { label: "w2", values: { shipped: 0, abandoned: 2 } },
    ],
    ["shipped", "abandoned"],
    100,
  );
  assert.equal(v.yMax, 4);
  assert.deepEqual(v.bars, [
    {
      label: "w1",
      x: 75,
      width: 350,
      segments: [
        { key: "shipped", y: 25, height: 75, value: 3 },
        { key: "abandoned", y: 0, height: 25, value: 1 },
      ],
    },
    {
      label: "w2",
      x: 575,
      width: 350,
      segments: [{ key: "abandoned", y: 50, height: 50, value: 2 }],
    },
  ]);
}
console.log("✓ stackedBarView");

// 3. heatmapView: cells tile W × h, intensity is value ÷ max, null stays null.
{
  const v = heatmapView(
    ["01", "02"],
    ["w1", "w2"],
    [
      [10, null],
      [5, 20],
    ],
    44,
  );
  assert.equal(v.max, 20);
  assert.deepEqual(
    v.cells.map((c) => [c.row, c.col, c.x, c.y, c.intensity]),
    [
      ["01", "w1", 0, 0, 0.5],
      ["01", "w2", 500, 0, null],
      ["02", "w1", 0, 22, 0.25],
      ["02", "w2", 500, 22, 1],
    ],
  );
  assert.ok(v.cells.every((c) => c.width * 2 === W && c.height * 2 === 44));
}
console.log("✓ heatmapView");

// 4. statTile and formatUsd.
assert.deepEqual(statTile("Cost", null, formatUsd), { label: "Cost", value: "—" });
assert.deepEqual(statTile("N", 3, String, "sub"), { label: "N", value: "3", sub: "sub" });
assert.deepEqual([formatUsd(0.424), formatUsd(12.4), formatUsd(1234)], ["$0.42", "$12", "$1.2k"]);
console.log("✓ statTile, formatUsd");

// 5–6. The view model over three weekly rows, versions 0.9.0, 0.10.0 and unknown.
const pct = (p50, p90, count) => ({ p50Minutes: p50, p90Minutes: p90, count });
const NONE = pct(null, null, 0);
const slice = (o = {}) => ({
  shipped: 0,
  abandoned: 0,
  stages: {},
  leadToMerge: NONE,
  leadToRelease: NONE,
  tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
  estUsd: null,
  costUnknown: 0,
  byModel: {},
  cacheReadShare: null,
  activeMinutes: 0,
  wallClockMinutes: 0,
  gate: { runs: 0, wallMinutes: 0, firstPassRate: null, passed: 0, workspaces: 0 },
  ...o,
});
const gate = (passed, workspaces) => ({ ...slice().gate, passed, workspaces });
const v10 = slice({
  shipped: 2,
  stages: { "03_implement": pct(90, 120, 2) },
  leadToMerge: pct(300, 600, 2),
  estUsd: 4,
  gate: gate(1, 2),
});
const v9 = slice({ abandoned: 1, stages: { "01_research": pct(30, 30, 1) }, estUsd: 1.5 });
const trends = {
  range: "30d",
  bucket: "week",
  from: "2026-10-26",
  to: "2026-11-20T12:00:00.000Z",
  rows: [
    { bucket: "2026-10-26", ...slice(), byVersion: {} },
    { bucket: "2026-11-02", ...v9, byVersion: { "0.9.0": v9 } },
    {
      bucket: "2026-11-09",
      ...v10,
      gate: gate(2, 3),
      byVersion: { "0.10.0": v10, unknown: slice({ gate: gate(1, 1) }) },
    },
  ],
};

assert.deepEqual(versionsOf(trends), ["0.10.0", "0.9.0", "unknown"]);
const all = sliceRows(trends, "all");
assert.equal(all[1].slice, trends.rows[1]);
const only9 = sliceRows(trends, "0.9.0");
assert.deepEqual(
  only9.map((r) => (r.slice ? r.slice.abandoned : null)),
  [null, 1, null],
);
assert.ok(!isEmpty(all) && !isEmpty(only9));
assert.ok(isEmpty(sliceRows(trends, "0.1.0")), "a version with no rows is empty");
assert.ok(isEmpty(sliceRows({ ...trends, rows: [trends.rows[0]] }, "all")), "zero rows are empty");
assert.ok(isEmpty(sliceRows({ ...trends, rows: [] }, "all")));
// Gate runs or a merge with nothing closed yet still count (Q6, revised).
const onlyGate = {
  bucket: "2026-11-16",
  ...slice({ gate: { ...gate(1, 1), runs: 2 } }),
  byVersion: {},
};
assert.ok(!isEmpty(sliceRows({ ...trends, rows: [onlyGate] }, "all")));
const onlyMerge = {
  bucket: "2026-11-16",
  ...slice({ leadToMerge: pct(403, 403, 1) }),
  byVersion: {},
};
assert.ok(!isEmpty(sliceRows({ ...trends, rows: [onlyMerge] }, "all")));
// A first-pass result whose gate.start is missing has workspaces but no runs.
assert.ok(!isEmpty(sliceRows(trends, "unknown")));
assert.deepEqual(
  [
    emptyText("30d", "all"),
    emptyText("7d", "0.9.0"),
    emptyText("all", "all"),
    emptyText("90d", "unknown"),
  ],
  [
    "No activity in the last 30 days",
    "No activity in the last 7 days for 0.9.0",
    "No activity yet",
    "No activity in the last 90 days with no version recorded",
  ],
);
console.log("✓ versionsOf, sliceRows, isEmpty, emptyText");

assert.deepEqual(metricsTiles(all), [
  { label: "Shipped", value: "2" },
  { label: "Abandoned", value: "1" },
  { label: "Est. cost", value: "$5.50" },
  { label: "Gate first pass", value: "67%", sub: "2 of 3 workspaces" },
]);
assert.equal(metricsTiles(only9)[3].value, "—", "no gate runs → unknown first-pass rate");
const p = previewCharts(all);
assert.deepEqual(
  p.lead.map((l) => [l.label, l.p50, l.p90]),
  [
    ["2026-10-26", null, null],
    ["2026-11-02", null, null],
    ["2026-11-09", 300, 600],
  ],
);
assert.deepEqual(
  p.closed.map((b) => b.values),
  [
    { shipped: 0, abandoned: 0 },
    { shipped: 0, abandoned: 1 },
    { shipped: 2, abandoned: 0 },
  ],
);
assert.deepEqual(p.stages, {
  rows: ["01_research", "03_implement"],
  cols: ["2026-10-26", "2026-11-02", "2026-11-09"],
  grid: [
    [null, 30, null],
    [null, null, 90],
  ],
});
console.log("✓ metricsTiles, previewCharts");

// 7. Daily points only for 7d.
assert.deepEqual(RANGE_BUCKET, { "7d": "day", "30d": "week", "90d": "week", all: "week" });
// 8. scatterView (SW-783): dots across x0..x1, p50/p90 rows, `over` only past p90.
{
  const v = scatterView(
    [
      { t: 0, value: 10, label: "a" },
      { t: 50, value: 30, label: "b" },
      { t: 100, value: 60, label: "c" },
    ],
    30,
    50,
    0,
    100,
    100,
  );
  assert.equal(v.yMax, 60);
  assert.deepEqual(
    v.dots.map((d) => [d.x, d.y, d.over]),
    [
      [0, 83.3, false],
      [500, 50, false],
      [1000, 0, true],
    ],
  );
  assert.equal(v.p50Y, 50);
  assert.equal(v.p90Y, 16.7);
  // One instant: every dot centred. p90 above every value sets the y-max.
  const one = scatterView([{ t: 5, value: 10, label: "x" }], null, 40, 5, 5, 100);
  assert.equal(one.dots[0].x, W / 2);
  assert.equal(one.yMax, 40);
  assert.equal(one.p50Y, null);
  assert.equal(scatterView([], null, null, 0, 1, 100).yMax, 1);
}
console.log("charts smoke: OK");
