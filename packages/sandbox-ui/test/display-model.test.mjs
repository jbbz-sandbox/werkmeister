// The display model: one case per agent, container, service, PR and CI state
// (ui-spec § The card / § Badges / § Actions), plus the no-DOM guarantee.
// Run: npm run build && node --test test/display-model.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const { displayModel, ago } = await import("../dist/display-model.js");

const NOW = new Date("2026-10-20T12:00:00Z");
const minsAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

const base = {
  state: "up",
  running: 2,
  total: 2,
  services: [],
  claude: { agent: "idle", at: null, question: null },
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
};
const model = (ws = {}, opts = {}) => displayModel({ ...base, ...ws }, { now: NOW, ...opts });
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
      claude: { agent, at: minsAgo(12), question: "ICM or JIT?" },
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
  const needs = { claude: { agent: "needs-you", at: null, question: null } };
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

test("ago", () => {
  assert.equal(ago(null, NOW), "");
  assert.equal(ago(new Date(NOW.getTime() - 40_000).toISOString(), NOW), "40 s ago");
  assert.equal(ago(minsAgo(5 * 60), NOW), "5 h ago");
  assert.equal(ago(minsAgo(24 * 60), NOW), "1 day ago");
  assert.equal(ago(minsAgo(2 * 24 * 60), NOW), "2 days ago");
});
