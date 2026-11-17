import assert from "node:assert/strict";
import { test } from "node:test";
import { boardUrl, buildTree, cliNotFoundNode, inTerminal } from "../out/build-tree.js";
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
  // Line 2, straight after the name and state (SW-864).
  assert.match(html, /<\/span><\/div><div class="dim">opus · stage 2\/4 implement<\/div>/);
  assert.match(
    html,
    /data-cmd="sandbox.openIssue" data-id="a" class="name" title="Open SW-1 in jira.example">a<\/a>/,
  );
  assert.match(html, /data-cmd="sandbox.openPr" data-id="a\/pr\/[^"]+">r#1 ↗/);
  assert.match(html, /●<\/span> frontend <span class="dim">healthy/);
  // Needs you: the terminal button is the primary one and says why.
  assert.match(
    html,
    /<button type="button" data-cmd="sandbox.openTerminal" data-id="a" class="primary">Answer in terminal/,
  );
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

test("each PR gets a line of its own, its status in its own colour; the issue is the name", () => {
  const pr = (over) => ({ url: PR, state: "OPEN", ci: null, failingChecks: 0, ...over });
  const card = (prs) =>
    renderCards(
      buildTree([ws("a", { issueId: "SW-1" })], [st("a")], null, [], {
        prs: new Map([["a", prs]]),
      }),
    );
  const open = card([pr(), pr({ url: "https://github.com/o/r/pull/2" })]);
  // No issue URL: the name is plain text and there is no separate issue line.
  assert.match(open, /<span class="name">a<\/span>/);
  assert.doesNotMatch(open, /SW-1/);
  assert.match(open, /<div><a [^>]+>r#1 ↗<\/a> /);
  assert.equal(open.match(/<div><a [^>]+>r#\d ↗/g).length, 2);
  assert.match(open, /<span class="c-charts-green">Open<\/span>/);
  assert.match(
    card([pr({ ci: "fail", failingChecks: 2 })]),
    /<span class="c-errorForeground">CI ✗ 2 failing<\/span>/,
  );
  assert.match(card([pr({ state: "MERGED" })]), /<span class="c-charts-purple">Merged<\/span>/);
  assert.match(
    card([pr({ state: "MERGED", release: "v1.2.0" })]),
    /<span class="c-charts-blue">Released v1.2.0<\/span>/,
  );
});

test("nothing a workspace supplies reaches the page as markup", () => {
  const html = renderCards(tree());
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&#60;img src=x onerror=&#34;1&#34;&#62;/);
});

test("a right-click gets the node's contextValue and the fields the commands read", () => {
  const [, raw] = renderCards(tree()).match(
    /<article class="card" id="ws-a" data-vscode-context="([^"]+)"/,
  );
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

// --- SW-864: the cue on whichever tile the active terminal shows -------------

test("a terminal's cwd names a workspace, Master control, or nothing", () => {
  const list = [
    { name: "a", path: "/ws/a" },
    { name: "a-inner", path: "/ws/a/inner" },
  ];
  assert.deepEqual(inTerminal(list, "/ws/a", "/ws"), { kind: "workspace", name: "a" });
  assert.deepEqual(inTerminal(list, "/ws/a/src", "/ws"), { kind: "workspace", name: "a" });
  assert.deepEqual(inTerminal(list, "/ws/a/inner/x", "/ws"), {
    kind: "workspace",
    name: "a-inner",
  });
  assert.deepEqual(inTerminal(list, "/ws/", "/ws"), { kind: "root" });
  assert.equal(inTerminal(list, "/ws/other", "/ws"), null);
  assert.equal(inTerminal(list, "/home/me", "/ws"), null);
  assert.equal(inTerminal(list, undefined, "/ws"), null);
});

test("exactly one tile gets the cue: the card, or Master control, or none", () => {
  const nodes = buildTree([ws("a"), ws("b")], [st("a"), st("b")], null, []);
  const cued = (t) =>
    [
      ...renderCards(nodes, { inTerminal: t }).matchAll(
        /<(article|section) class="card[^"]*in-terminal[^"]*"( id="([^"]+)")?/g,
      ),
    ].map((m) => m[3] ?? "master");
  assert.deepEqual(cued({ kind: "workspace", name: "b" }), ["ws-b"]);
  assert.deepEqual(cued({ kind: "root" }), ["master"]);
  assert.deepEqual(cued(null), []);
  assert.deepEqual(cued({ kind: "workspace", name: "gone" }), []);
  assert.equal(
    renderCards(nodes, { inTerminal: { kind: "root" } }).match(/In terminal/g).length,
    1,
  );
});

test("Master control counts what needs you and links each count to its first card", () => {
  const needs = { state: null, agent: "needs-you", at: null, question: "?" };
  const html = renderCards(
    buildTree(
      [ws("a"), ws("b"), ws("c")],
      [st("a"), st("b", { claude: needs }), st("c", { claude: needs })],
      null,
      [],
      { prs: new Map([["a", [{ url: PR, state: "OPEN", ci: null, failingChecks: 0 }]]]) },
    ),
  );
  assert.match(html, /<a href="#ws-b" class="c-charts-yellow">2 need you<\/a>/);
  assert.match(html, /<a href="#ws-a">1 PR to review<\/a>/);
  // Nothing to count: no line at all.
  assert.doesNotMatch(renderCards(buildTree([ws("a")], [st("a")], null, [])), /to review|need/);
});

test("the Jira board button shows only with a board, and links to it", () => {
  const nodes = tree();
  assert.doesNotMatch(renderCards(nodes), /sandbox\.openBoard/);
  assert.match(
    renderCards(nodes, { board: "https://x.atlassian.net/jira/software/projects/SW/boards/1" }),
    /data-cmd="sandbox.openBoard" data-id="" title="https:\/\/x.atlassian.net\/[^"]+">Jira board ↗/,
  );
  const jira = (over) => ({
    tracker: "jira",
    scope: { project: "SW" },
    board: { id: "1" },
    default: true,
    ...over,
  });
  assert.equal(
    boardUrl("https://x.atlassian.net/", [jira()]),
    "https://x.atlassian.net/jira/software/projects/SW/boards/1",
  );
  assert.equal(boardUrl("https://x.atlassian.net", [jira({ board: undefined })]), null);
  assert.equal(boardUrl(undefined, [jira()]), null);
  assert.equal(boardUrl("https://x.atlassian.net", [jira({ tracker: "github" })]), null);
  // Several projects and none marked default: no guess.
  assert.equal(
    boardUrl("https://x.atlassian.net", [jira({ default: false }), jira({ default: false })]),
    null,
  );
});
