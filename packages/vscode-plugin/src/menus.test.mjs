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
import { buildTree, cliNotFoundNode } from "../out/build-tree.js";

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
  project: `sandbox-${name}`,
  state: "down",
  running: 0,
  total: 0,
  slot: null,
  ports: null,
  services: [],
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
 * Evaluate a `view/item/context` clause the way VS Code does, for our one view.
 * Only the `viewItem =~ /…/` half varies between entries; the `view ==` half is
 * asserted separately so a clause that forgot it can't quietly pass here.
 *
 * A lifecycle command has both an inline entry and a right-click one; the
 * inline entry is the state-gated one and so the one worth testing.
 */
function shows(command, contextValue) {
  const entries = manifest.contributes.menus["view/item/context"].filter(
    (m) => m.command === command,
  );
  const entry = entries.find((m) => m.group.startsWith("inline")) ?? entries[0];
  assert.ok(entry, `no view/item/context entry for ${command}`);
  assert.match(entry.when, /view == sandboxWorkspaces/, `${command} is not scoped to the view`);
  const [, source, flags] = entry.when.match(/viewItem =~ \/(.+?)\/([a-z]*)(?: |$)/);
  return new RegExp(source, flags).test(contextValue);
}

test("switch is offered on every workspace except the one this window is in", () => {
  for (const state of ["up", "partial", "stopped", "down", "unknown"]) {
    assert.equal(shows("sandbox.switch", workspaceContext(state)), true, state);
    assert.equal(shows("sandbox.switch", workspaceContext(state, true)), false, `${state} current`);
  }
});

test("open is offered on every workspace, current or not", () => {
  for (const state of ["up", "down"]) {
    assert.equal(shows("sandbox.open", workspaceContext(state)), true);
    assert.equal(shows("sandbox.open", workspaceContext(state, true)), true);
  }
});

// The inline ▶ / ⏸ pair is state-gated, and the `:current` suffix must not
// silently un-gate or un-show it — the regression this file exists for.
test("start shows only where there is something to start, current or not", () => {
  for (const isCurrent of [false, true]) {
    for (const state of ["down", "stopped", "partial"]) {
      assert.equal(shows("sandbox.up", workspaceContext(state, isCurrent)), true, state);
    }
    assert.equal(shows("sandbox.up", workspaceContext("up", isCurrent)), false);
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
    "sandbox.switch",
    "sandbox.up",
    "sandbox.stop",
    "sandbox.closeOut",
  ]) {
    assert.equal(shows(command, service), false, `${command} on a service`);
    assert.equal(shows(command, error), false, `${command} on the error node`);
  }
});

// These need a tree node for their argument; a bare palette invocation has
// nothing to pass, so they are hidden rather than left to fail at runtime.
test("the node-only commands are hidden from the palette", () => {
  const hidden = manifest.contributes.menus.commandPalette
    .filter((m) => m.when === "false")
    .map((m) => m.command);
  assert.deepEqual(hidden.sort(), ["sandbox.logs", "sandbox.openIssue", "sandbox.toggleIntercept"]);
});

test("every command a menu references is declared", () => {
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const { command } of entries) {
      assert.ok(declared.has(command), `${menu} references undeclared ${command}`);
    }
  }
});
