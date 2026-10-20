// The React workspace card rendered with react-dom/server: one case per state the
// handoff README's acceptance checks name (SW-53). No DOM library needed.
// Run: npm run build && node --test test/workspace-card.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { displayModel } = await import("../dist/display-model.js");
const { WorkspaceCard, ConfirmFooter, barFor, desktopLink, toolCall } = await import(
  "../dist/workspace-card.js"
);

const status = (over = {}) => ({
  state: "up",
  running: 2,
  total: 2,
  services: [
    { name: "cli", state: "healthy" },
    { name: "dashboard", state: "unhealthy" },
  ],
  claude: { agent: "working", at: null, question: null },
  stage: { index: 2, total: 4, name: "spec" },
  phase: null,
  autonomous: false,
  lastActivity: null,
  ...over,
});
const pr = (over = {}) => ({
  url: "https://github.com/jbbz-sandbox/werkmeister/pull/231",
  state: "OPEN",
  ci: "running",
  failingChecks: 0,
  ...over,
});
const noop = () => undefined;
const card = ({ ws = {}, prs = [], lifecycle = null, ...props } = {}) =>
  renderToStaticMarkup(
    h(WorkspaceCard, {
      name: "sandbox-53-react-card",
      path: "/ws/sandbox-53-react-card",
      task: "Build the card in React",
      workType: "feature",
      issueId: "SW-53",
      issueUrl: "https://jira.example/browse/SW-53",
      display: displayModel(status(ws), { prs, lifecycle }),
      state: status(ws).state,
      prsLoading: false,
      busy: null,
      error: null,
      onAction: noop,
      onOpenLink: noop,
      mountPanel: noop,
      ...props,
    }),
  );

test("Needs you: amber card, solid chip, last question; nothing else is amber", () => {
  const needs = card({ ws: { claude: { agent: "needs-you", at: null, question: "ICM or JIT?" } } });
  assert.match(needs, /class="ws-card attn"/);
  assert.match(needs, /class="chip t-needs">● Needs you</);
  assert.match(needs, /Last question/);
  assert.match(needs, /ICM or JIT\?/);
  for (const agent of ["working", "done", "idle"]) {
    const html = card({ ws: { claude: { agent, at: null, question: "ICM or JIT?" } } });
    assert.doesNotMatch(html, /attn|t-needs|Last question/, agent);
  }
});

test("header: type tag, task title, issue; no issue reads 'no issue'", () => {
  const html = card({ workType: "bugfix" });
  assert.match(html, /class="type-tag">Bug</);
  assert.match(html, /Build the card in React/);
  assert.match(html, />SW-53</);
  assert.match(card({ issueId: null, issueUrl: null }), /class="faint">no issue</);
});

test("rows: containers, services, PR badge + CI, stage pips, agent", () => {
  const html = card({ prs: [pr()] });
  assert.match(html, /2 of 2 up/);
  assert.match(html, /class="svc t-err hot"><span class="g">▲<\/span> dashboard unhealthy/);
  assert.match(html, />werkmeister#231</);
  assert.match(html, /class="badge t-ok">Open</);
  assert.match(html, /class="ci t-warn">.*CI running/);
  assert.match(html, /Stage 2 of 4 · spec/);
  assert.equal(html.match(/class="pip /g).length, 4);
  assert.match(html, /class="agent">.*Working/);
});

test("Draft PRs have a dashed badge", () => {
  assert.match(card({ prs: [pr({ draft: true })] }), /class="badge t-off dashed">Draft</);
  assert.doesNotMatch(card({ prs: [pr()] }), /dashed/);
});

test("retry states: PRs unavailable and Docker unreachable", () => {
  assert.match(card({ prs: null }), /PRs unavailable · <button type="button" class="link">retry</);
  const down = card({ ws: { state: "unknown", services: [] } });
  assert.match(down, /Docker unreachable · <button type="button" class="link">retry</);
  assert.match(card({ prs: [] }), /None yet/);
});

test("loading: skeleton before status, and a PRs row that says loading", () => {
  const sk = card({ display: null, state: null });
  assert.match(sk, /aria-busy="true"/);
  assert.match(sk, />sandbox-53-react-card</);
  for (const label of ["Containers", "PRs", "Workflow", "Agent"])
    assert.match(sk, new RegExp(`>${label}<`));
  assert.equal(sk.match(/>loading</g).length, 4);
  assert.match(card({ prsLoading: true }), /class="sk w140"/);
});

test("Close out primary uses the destructive style; no 'Click again to confirm'", () => {
  const html = card({
    ws: { claude: { agent: "done", at: null, question: null } },
    lifecycle: "shipped",
  });
  assert.match(html, /class="btn primary destructive"[^>]*>✓ Close out</);
  assert.match(html, /Ready to close out/);
  assert.doesNotMatch(html, /Click again/);
});

test("Abandon can't be confirmed with an empty reason", () => {
  const footer = (reason) =>
    renderToStaticMarkup(
      h(ConfirmFooter, {
        kind: "abandon",
        name: "ws",
        reason,
        onReason: noop,
        onConfirm: noop,
        onCancel: noop,
      }),
    );
  for (const empty of ["", "   "])
    assert.match(footer(empty), /<button type="button" class="btn abandon-yes" disabled="">/);
  assert.match(footer("superseded"), /<button type="button" class="btn abandon-yes">/);
  assert.match(footer(""), /Reason \(required\)/);
  const close = renderToStaticMarkup(
    h(ConfirmFooter, {
      kind: "close-out",
      name: "ws",
      reason: "",
      onReason: noop,
      onConfirm: noop,
      onCancel: noop,
    }),
  );
  assert.match(close, /Close out ws\?/);
  assert.match(close, /✓ Yes, close out/);
});

test("barFor: primary + two secondaries, the rest in ⋯", () => {
  const labels = (r) => [r.secondary.map((b) => b.label), r.extra.map((b) => b.label)];
  const d = (ws, lifecycle = null) => displayModel(status(ws), { lifecycle });
  const panels = ["Chat", "Usage", "Open in VS Code"];
  assert.deepEqual(labels(barFor(d({}), "up")), [
    ["■ Stop", "↻ Restart"],
    ["↗ Continue in Desktop", "⏻ Down", "＋ New session", ...panels],
  ]);
  assert.deepEqual(labels(barFor(d({ state: "down" }), "down")), [
    ["↗ Continue in Terminal", "＋ New session"],
    ["↗ Continue in Desktop", ...panels],
  ]);
  assert.deepEqual(
    labels(
      barFor(
        d({ state: "down", claude: { agent: "needs-you", at: null, question: null } }),
        "down",
      ),
    ),
    [
      ["▶ Up", "＋ New session"],
      ["↗ Continue in Desktop", ...panels],
    ],
  );
  assert.deepEqual(
    labels(barFor(d({ claude: { agent: "done", at: null, question: null } }, "shipped"), "up")),
    [
      ["↻ Restart", "⏻ Down"],
      ["↗ Continue in Terminal", "↗ Continue in Desktop", "＋ New session", ...panels],
    ],
  );
});

test("SW-54: Abandon goes through close-out with the reason, and never without one", () => {
  assert.deepEqual(toolCall("abandon", "ws", "  superseded by SW-60 "), {
    tool: "close-out",
    verb: "Abandoning",
    args: { workspace: "ws", abandon: "superseded by SW-60" },
  });
  for (const blank of [undefined, "", "   "]) assert.equal(toolCall("abandon", "ws", blank), null);
  assert.deepEqual(toolCall("close-out", "ws").args, { workspace: "ws" });
});

test("SW-54: New session opens a fresh Terminal session; Continue resumes", () => {
  assert.deepEqual(toolCall("new-session", "ws"), {
    tool: "claude-resume",
    verb: "Opening Terminal",
    args: { workspace: "ws", new: true },
  });
  assert.deepEqual(toolCall("continue", "ws").args, { workspace: "ws" });
  assert.equal(toolCall("up", "ws").tool, "up");
  for (const linkOnly of ["continue-desktop", "open-issue", "chat"])
    assert.equal(toolCall(linkOnly, "ws"), null, linkOnly);
});

test("SW-54: Continue in Desktop opens the folder's claude:// link", () => {
  assert.equal(
    desktopLink("/Users/me/ws/a b&c"),
    "claude://code/new?folder=%2FUsers%2Fme%2Fws%2Fa%20b%26c&source=services",
  );
});

test("SW-54: the card draws New session in the bar when containers are down; no Remove", () => {
  const down = card({ ws: { state: "down", running: 0, services: [] } });
  assert.match(down, /class="btn"[^>]*>＋ New session</);
  assert.match(down, />▶ Up</);
  for (const html of [down, card()]) assert.doesNotMatch(html, /Remove|Resume in|>Start</);
});
