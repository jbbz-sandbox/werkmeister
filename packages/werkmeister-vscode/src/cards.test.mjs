import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree, cliNotFoundNode } from "../out/build-tree.js";
import { CARD_COMMANDS, findNode, renderCards } from "../out/cards.js";

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

const PR = "https://github.com/o/r/pull/1";
const tree = () =>
  buildTree(
    [ws("a", { issueId: "SW-1", issueUrl: "https://jira.example/browse/SW-1" })],
    [
      st("a", {
        state: "up",
        running: 1,
        total: 1,
        services: [{ name: "frontend", state: "healthy" }],
        stage: { index: 2, total: 4, name: "implement" },
        model: "opus",
        claude: { state: null, agent: "needs-you", at: null, question: '<img src=x onerror="1">' },
      }),
    ],
    null,
    [],
    { prs: new Map([["a", [{ url: PR, state: "OPEN", ci: null, failingChecks: 0 }]]]) },
  );

test("a card carries the stage name, the model, the issue, each PR and each container", () => {
  const html = renderCards(tree());
  assert.match(html, /opus · stage 2\/4 implement/);
  assert.match(html, /data-cmd="sandbox.openIssue" data-id="a">SW-1 ↗/);
  assert.match(html, /data-cmd="sandbox.openPr" data-id="a\/pr\/[^"]+">r#1 ↗/);
  assert.match(html, /●<\/span> frontend <span class="dim">healthy/);
  assert.match(html, /<button type="button" data-cmd="sandbox.openTerminal" data-id="a">/);
  assert.match(html, /<button type="button" data-cmd="sandbox.masterControl"/);
  assert.match(html, /<button type="button" data-cmd="sandbox.dashboard"/);
});

test("the card's one button acts on the run: start it, hold it, or pick it back up", () => {
  const card = (over) => renderCards(buildTree([ws("a")], [st("a", over)], null, []));
  const button = (html) =>
    html.match(/data-cmd="sandbox\.(startWork|pause|resume)" data-id="a">([^<]+)/);
  // Nobody has started it: no turn ever signalled, first stage at most.
  assert.equal(button(card({}))[2], "▶ Start work");
  assert.equal(button(card({ stage: { index: 1, total: 4, name: "scope" } }))[1], "startWork");
  // A live run, or containers still running under a finished one.
  const working = { state: null, agent: "working", at: "2026-10-22T10:00:00Z", question: null };
  assert.equal(button(card({ claude: working }))[2], "⏸ Pause");
  assert.equal(
    button(card({ state: "up", running: 1, total: 1, lastActivity: "2026-10-22T10:00:00Z" }))[1],
    "pause",
  );
  const paused = { at: "2026-10-22T10:00:00Z", containers: [] };
  assert.equal(button(card({ state: "paused", paused, claude: working }))[2], "▶ Resume");
  // Past the first stage with nothing live and nothing running: nothing to start or hold.
  assert.equal(button(card({ stage: { index: 3, total: 4, name: "verify" } })), null);
  assert.doesNotMatch(card({ state: "up", running: 1, total: 1 }), /sandbox\.up"/);
});

test("nothing a workspace supplies reaches the page as markup", () => {
  const html = renderCards(tree());
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&#60;img src=x onerror=&#34;1&#34;&#62;/);
});

test("a right-click gets the node's contextValue and the fields the commands read", () => {
  const [, raw] = renderCards(tree()).match(/<article class="card" data-vscode-context="([^"]+)"/);
  const ctx = JSON.parse(raw.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)));
  assert.equal(ctx.webviewSection, "workspace:up");
  assert.deepEqual([ctx.workspace.name, ctx.workspace.path], ["a", "/ws/a"]);
});

test("every click names an allowed command and a node the host can find", () => {
  const nodes = [...tree(), cliNotFoundNode("boom")];
  const clicks = [...renderCards(nodes).matchAll(/data-cmd="([^"]+)" data-id="([^"]*)"/g)];
  assert.equal(clicks.length, 7);
  for (const [, cmd, id] of clicks) {
    assert.ok(CARD_COMMANDS.includes(cmd), cmd);
    if (id) assert.ok(findNode(nodes, id), id);
  }
});
