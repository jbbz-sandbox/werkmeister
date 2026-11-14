/**
 * The manifest half of the view: which inline action shows on which node, and
 * which commands stay out of the palette.
 *
 * `when` clauses are regexes over `contextValue`, a string this repo's own
 * build-tree.ts produces — so the two drift apart silently, exactly as they did
 * when the `:current` suffix was added under `/^workspace:(up|partial)$/`.
 * Every case below feeds a real buildTree node into the real clause from
 * package.json rather than asserting either side alone.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildTree, cliNotFoundNode, LEGEND_NODE } from "../out/build-tree.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const ws = (name, over = {}) => ({
  name,
  path: `/ws/${name}`,
  issueId: null,
  issueUrl: null,
  labels: [],
  ...over,
});

const st = (name, over = {}) => ({
  name,
  project: `werkmeister-${name}`,
  state: "down",
  running: 0,
  total: 0,
  slot: null,
  ports: null,
  services: [],
  claude: { state: null, agent: "idle", at: null, question: null },
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
  ...over,
});

/** The contextValue buildTree gives a workspace in `state`, current or not. */
function workspaceContext(state, isCurrent = false) {
  const [node] = buildTree([ws("a")], [st("a", { state })], null, isCurrent ? ["/ws/a"] : []);
  return node.contextValue;
}

/** The contextValue buildTree gives a service, given its intercept row. */
function serviceContext(row) {
  const [node] = buildTree(
    [ws("a")],
    [
      st("a", {
        state: "up",
        running: 1,
        total: 1,
        services: [{ name: "frontend", state: "healthy" }],
      }),
    ],
    {
      available: true,
      installed: true,
      byFeature: new Map([["a", new Map([["frontend", row]])]]),
      remoteServices: new Set(["frontend"]),
    },
    [],
  );
  return node.children[0].contextValue;
}

const interceptRow = (over = {}) => ({
  interceptable: true,
  blocker: null,
  intercepted: false,
  intercepted_by: null,
  ...over,
});

/**
 * Evaluate a `webview/context` clause the way VS Code does, for our one view.
 * cards.ts puts a node's contextValue in `webviewSection`, so only the
 * `webviewSection =~ /…/` half varies between entries; the `webviewId ==` half is
 * asserted separately so a clause that forgot it can't quietly pass here.
 */
function shows(command, contextValue) {
  const entries = manifest.contributes.menus["webview/context"].filter(
    (m) => m.command === command,
  );
  assert.equal(entries.length, 1, `one webview/context entry for ${command}`);
  const [entry] = entries;
  assert.match(
    entry.when,
    /webviewId == 'sandboxWorkspaces'/,
    `${command} is not scoped to the view`,
  );
  const [, source, flags] = entry.when.match(/webviewSection =~ \/(.+?)\/([a-z]*)(?: |$)/);
  return new RegExp(source, flags).test(contextValue);
}

test("open is offered on every workspace, current or not", () => {
  for (const state of ["up", "down"]) {
    assert.equal(shows("sandbox.open", workspaceContext(state)), true);
    assert.equal(shows("sandbox.open", workspaceContext(state, true)), true);
  }
});

// The ▶ / ⏸ pair is state-gated, and the `:current` suffix must not
// silently un-gate or un-show it — the regression this file exists for.
test("start shows only where there is something to start, current or not", () => {
  for (const isCurrent of [false, true]) {
    for (const state of ["down", "stopped", "partial"]) {
      assert.equal(shows("sandbox.up", workspaceContext(state, isCurrent)), true, state);
    }
    assert.equal(shows("sandbox.up", workspaceContext("up", isCurrent)), false);
    assert.equal(shows("sandbox.up", workspaceContext("paused", isCurrent)), false, "paused");
  }
});

test("stop shows only where there is something to stop, current or not", () => {
  for (const isCurrent of [false, true]) {
    for (const state of ["up", "partial"]) {
      assert.equal(shows("sandbox.stop", workspaceContext(state, isCurrent)), true, state);
    }
    for (const state of ["down", "stopped"]) {
      assert.equal(shows("sandbox.stop", workspaceContext(state, isCurrent)), false, state);
    }
  }
});

// Only one intercept exists per Deployment, so offering the toggle on someone
// else's intercept would send a `--leave` that fails.
test("the intercept toggle shows on interceptable and own intercepts only", () => {
  assert.equal(shows("sandbox.toggleIntercept", serviceContext(interceptRow())), true);
  assert.equal(
    shows(
      "sandbox.toggleIntercept",
      serviceContext(interceptRow({ intercepted: true, intercepted_by: "a" })),
    ),
    true,
  );
  assert.equal(
    shows(
      "sandbox.toggleIntercept",
      serviceContext(interceptRow({ intercepted: true, intercepted_by: "other" })),
    ),
    false,
  );
  assert.equal(
    shows(
      "sandbox.toggleIntercept",
      serviceContext(interceptRow({ interceptable: false, blocker: "no deployment" })),
    ),
    false,
  );
  assert.equal(shows("sandbox.toggleIntercept", serviceContext(undefined)), false);
});

test("no workspace action is offered on a service node, or on the CLI-not-found node", () => {
  const service = serviceContext(interceptRow());
  const error = cliNotFoundNode("boom").contextValue;
  for (const command of [
    "sandbox.open",
    "sandbox.up",
    "sandbox.stop",
    "sandbox.closeOut",
    "sandbox.abandon",
  ]) {
    assert.equal(shows(command, service), false, `${command} on a service`);
    assert.equal(shows(command, error), false, `${command} on the error node`);
    assert.equal(shows(command, prContext()), false, `${command} on a PR row`);
    assert.equal(shows(command, LEGEND_NODE.contextValue), false, `${command} on the legend`);
  }
});

/** The contextValue of a PR row under a workspace. */
function prContext() {
  const [node] = buildTree([ws("a")], [st("a")], null, [], {
    prs: new Map([
      ["a", [{ url: "https://github.com/o/r/pull/1", state: "OPEN", ci: null, failingChecks: 0 }]],
    ]),
  });
  return node.children[0].contextValue;
}

// SW-55: both end verbs are on every workspace, current or not.
test("both end verbs show on every workspace", () => {
  for (const command of ["sandbox.closeOut", "sandbox.abandon"]) {
    for (const state of ["up", "partial", "stopped", "paused", "down", "unknown"]) {
      assert.equal(shows(command, workspaceContext(state)), true, `${command} ${state}`);
      assert.equal(shows(command, workspaceContext(state, true)), true, `${command} ${state}`);
    }
  }
});

// The card's own button and links do these, and ↻ Refresh PRs is in the view's title bar.
test("the card's own actions are not repeated on its right-click menu", () => {
  const menu = manifest.contributes.menus["webview/context"].map((m) => m.command);
  for (const command of [
    "sandbox.continue",
    "sandbox.switch",
    "sandbox.newSession",
    "sandbox.openIssue",
    "sandbox.openPr",
    "sandbox.refreshPrs",
    "sandbox.pause",
    "sandbox.resume",
  ]) {
    assert.equal(menu.includes(command), false, command);
  }
});

test("there is no Remove action", () => {
  for (const { command, title } of manifest.contributes.commands) {
    assert.doesNotMatch(`${command} ${title}`, /remove/i);
  }
});

// These need a tree node for their argument; a bare palette invocation has
// nothing to pass, so they are hidden rather than left to fail at runtime.
test("the node-only commands are hidden from the palette", () => {
  const hidden = manifest.contributes.menus.commandPalette
    .filter((m) => m.when === "false")
    .map((m) => m.command);
  assert.deepEqual(hidden.sort(), [
    "sandbox.logs",
    "sandbox.openIssue",
    "sandbox.openPr",
    "sandbox.toggleIntercept",
  ]);
});

test("every command a menu references is declared", () => {
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const { command } of entries) {
      assert.ok(declared.has(command), `${menu} references undeclared ${command}`);
    }
  }
});
