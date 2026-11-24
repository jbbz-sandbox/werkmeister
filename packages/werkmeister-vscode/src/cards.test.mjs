import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardUrl,
  buildTree,
  cliNotFoundNode,
  inTerminal,
  isForemanTerminal,
  stripOf,
} from "../out/build-tree.js";
import { CARD_COMMANDS, findNode, renderCards } from "../out/cards.js";

const ws = (name, over = {}) => ({
  name,
  path: `/ws/${name}`,
  issueId: null,
  issueUrl: null,
  labels: [],
  ...over,
});

/** The model's agent word (SW-558), plus the session's question when it asked one. */
const ag = (id, since = null, question = null) => ({
  workspaceState: {
    phase: { id: "building", label: "Building", stage: null },
    activity: { id: "idle", label: "Idle", since: null, session: null },
    needs: question
      ? [
          {
            id: "question:s",
            kind: "question",
            what: question,
            since,
            action: "Answer it",
            source: "session",
          },
        ]
      : [],
    agent: { id, since },
  },
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
  claude: { state: null },
  ...ag("idle", null, null),
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
        claude: { state: null },
        ...ag("needs-you", null, '<img src=x onerror="1">'),
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
});

test("a staged workspace's card shows one segment per stage, the done ones filled (SW-961)", () => {
  const html = renderCards(tree());
  // Straight under the meta line, stage 2 of 4: one done, one current, two to go.
  assert.match(
    html,
    /stage 2\/4 implement<\/div><div class="stages" role="progressbar" aria-label="Stages" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1" aria-valuetext="1 of 4 stages done" title="1 of 4 stages done"><span class="done"><\/span><span class="current"><\/span><span class="next"><\/span><span class="next"><\/span><\/div>/,
  );
  const card = (over) => renderCards(buildTree([ws("a")], [st("a", over)], null, []));
  assert.match(
    card({ stage: { index: 1, total: 3, name: "research" } }),
    /aria-valuemax="3" aria-valuenow="0"/,
  );
  assert.doesNotMatch(card({}), /class="stages"/);
  assert.doesNotMatch(card({ phase: "implement" }), /class="stages"/);
});

test("the card's one button acts on the run: start it, hold it, or pick it back up", () => {
  const card = (over) => renderCards(buildTree([ws("a")], [st("a", over)], null, []));
  const button = (html) =>
    html.match(/data-cmd="sandbox\.(startWork|pause|resume)" data-id="a">([^<]+)/);
  // Nobody has started it: no turn ever signalled, first stage at most.
  assert.equal(button(card({}))[2], "▶ Start work");
  assert.equal(button(card({ stage: { index: 1, total: 4, name: "scope" } }))[1], "startWork");
  // A live run, or containers still running under a finished one.
  const working = ag("working", "2026-10-22T10:00:00Z");
  assert.equal(button(card(working))[2], "⏸ Pause");
  assert.equal(
    button(card({ state: "up", running: 1, total: 1, lastActivity: "2026-10-22T10:00:00Z" }))[1],
    "pause",
  );
  const paused = { at: "2026-10-22T10:00:00Z", containers: [] };
  assert.equal(button(card({ state: "paused", paused, ...working }))[2], "▶ Resume");
  // Past the first stage with nothing live and nothing running: nothing to start or hold.
  assert.equal(button(card({ stage: { index: 3, total: 4, name: "verify" } })), null);
  assert.doesNotMatch(card({ state: "up", running: 1, total: 1 }), /sandbox\.up"/);
});

test("SW-1052: a never-started workspace shows only Start work; a stopped one started before keeps Open terminal", () => {
  const card = (over) => renderCards(buildTree([ws("a")], [st("a", over)], null, []));
  const terminal = /data-cmd="sandbox\.openTerminal"/;
  assert.doesNotMatch(card({}), terminal);
  assert.match(card({}), /sandbox\.startWork/);
  // Stopped, nothing running, but a turn ran before: the session is there to continue.
  assert.match(card({ lastActivity: "2026-10-22T10:00:00Z" }), terminal);
  assert.match(card({ stage: { index: 3, total: 4, name: "verify" } }), terminal);
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
  assert.equal(clicks.length, 5);
  for (const [, cmd, id] of clicks) {
    assert.ok(CARD_COMMANDS.includes(cmd), cmd);
    if (id) assert.ok(findNode(nodes, id), id);
  }
});

// --- SW-864: the cue on whichever tile the active terminal shows -------------

test("a terminal's cwd names a workspace, the workspaces root, or nothing", () => {
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

test("exactly one tile gets the cue: the card, or none (the root chat has no tile since SW-1009)", () => {
  const nodes = buildTree([ws("a"), ws("b")], [st("a"), st("b")], null, []);
  const cued = (t) =>
    [
      ...renderCards(nodes, { inTerminal: t }).matchAll(
        /<(article|section) class="card[^"]*in-terminal[^"]*"( id="([^"]+)")?/g,
      ),
    ].map((m) => m[3] ?? "master");
  assert.deepEqual(cued({ kind: "workspace", name: "b" }), ["ws-b"]);
  assert.deepEqual(cued({ kind: "root" }), []);
  assert.deepEqual(cued(null), []);
  assert.deepEqual(cued({ kind: "workspace", name: "gone" }), []);
  assert.doesNotMatch(renderCards(nodes, { inTerminal: { kind: "root" } }), /In terminal/);
});

// SW-1009: the pinned strip replaces the Master control and Host cards.
test("the strip is pinned, links each chip to its first card, and shows the host line", () => {
  const needs = ag("needs-you", null, "?");
  const statuses = [st("a", { state: "up" }), st("b", needs), st("c", needs)];
  const extra = {
    host: { load: [14.6, 9.2, 8], cores: 12, featureCpuPercent: 358.4 },
    infra: { state: "partial", services: [{ name: "caddy", state: "down" }] },
  };
  const nodes = buildTree([ws("a"), ws("b"), ws("c")], statuses, null, [], extra);
  const html = renderCards(nodes, { strip: stripOf(nodes, statuses, extra) });
  assert.match(
    html,
    /^<header class="strip"><span class="host" title="load 1 · 5 · 15 min: 14\.6 · 9\.2 · 8 on 12 cores"><span class="c-charts-yellow">host 122% · features 3\.6 of 12 cores<\/span><span class="meter" aria-hidden="true"><span class="m-host w10"><\/span><span class="m-feat w3"><\/span><\/span><\/span><div class="chips"><a href="#ws-b" class="c-charts-yellow">● 2 need you<\/a><a href="#ws-a" class="c-charts-green">1 running<\/a><span class="c-errorForeground">infra: caddy down<\/span><\/div><\/header>/,
  );
  assert.doesNotMatch(html, /Master control|Triage, backlog|stalled|waiting|<section/);
  // A host row no longer leads the tree: the strip carries it.
  assert.equal(nodes[0].id, "a");
  // Nothing to count and no sweep yet: no strip at all.
  const idle = buildTree([ws("a")], [st("a")], null, []);
  assert.doesNotMatch(renderCards(idle, { strip: stripOf(idle, [st("a")]) }), /strip/);
});

test("Foreman's terminal is found by its new name and by the old Master control name", () => {
  assert.ok(isForemanTerminal("Foreman"));
  assert.ok(isForemanTerminal("Master control"));
  assert.ok(isForemanTerminal("Master control (2)"));
  assert.equal(isForemanTerminal("a · claude"), false);
});

test("boardUrl gives the default Jira project's board, else null", () => {
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

// SW-1003: the title-bar toggle hides merged cards waiting on a release, and says how many.
test("hide waiting on release: two merged and one working leave one card, the count reads 2", () => {
  const names = ["m1", "m2", "w"];
  const nodes = (life, statuses = {}) =>
    buildTree(
      names.map((n) => ws(n)),
      names.map((n) => st(n, statuses[n] ?? (n === "w" ? ag("working") : {}))),
      null,
      [],
      { lifecycles: new Map(Object.entries(life)) },
    );
  const merged = { m1: "merged", m2: "merged", w: "working" };
  const cards = (html) =>
    [...html.matchAll(/<article class="card[^"]*" id="ws-([^"]+)"/g)].map((m) => m[1]);

  const off = renderCards(nodes(merged));
  assert.deepEqual(cards(off), names, "off: every card, as today");
  assert.doesNotMatch(off, /hidden/);

  const on = renderCards(nodes(merged), { hideMerged: true });
  assert.deepEqual(cards(on), ["w"]);
  assert.match(on, /data-cmd="sandbox.showMerged"[^>]*>2 hidden · waiting on release</);

  // A release ships, or it needs the person: back on the next poll.
  assert.deepEqual(cards(renderCards(nodes({ ...merged, m1: "shipped" }), { hideMerged: true })), [
    "m1",
    "w",
  ]);
  const asks = nodes(merged, { m2: ag("needs-you", null, "Ship it?") });
  const shown = renderCards(asks, { hideMerged: true });
  assert.deepEqual(cards(shown), ["m2", "w"]);
  // SW-1133: a machine-wide notice (registry sync) is not waiting in this workspace.
  const notice = ag("needs-you");
  notice.workspaceState.needs = [
    {
      id: "notice:registry-werkmeister",
      kind: "notice",
      what: "Registry sync needed: the werkmeister fragment changed",
      since: null,
      action: "Run werkmeister registry sync",
      source: "notice",
    },
  ];
  assert.deepEqual(cards(renderCards(nodes(merged, { m2: notice }), { hideMerged: true })), ["w"]);
  // A held PR wake is a notice for this workspace's own session: still shown.
  const wake = ag("needs-you");
  wake.workspaceState.needs = [
    {
      id: "notice:wake-s1",
      kind: "notice",
      what: "A PR update is waiting for your open session",
      since: null,
      action: "Send that session a message, or let it finish its turn",
      source: "notice",
      session: "s1",
    },
  ];
  assert.deepEqual(cards(renderCards(nodes(merged, { m2: wake }), { hideMerged: true })), [
    "m2",
    "w",
  ]);
  // The strip still counts the hidden ones: a merged workspace whose other repo has a red PR.
  const extra = {
    lifecycles: new Map([["m1", "merged"]]),
    prs: new Map([["m1", [{ url: PR, state: "OPEN", ci: "fail", failingChecks: 1 }]]]),
  };
  const review = buildTree([ws("m1")], [st("m1")], null, [], extra);
  const hiddenReview = renderCards(review, {
    hideMerged: true,
    strip: stripOf(review, [st("m1")], extra),
  });
  assert.deepEqual(cards(hiddenReview), []);
  assert.match(
    hiddenReview,
    /<header class="strip"><div class="chips"><a href="#ws-m1" class="c-errorForeground">1 CI failed or conflicts<\/a><div>.*1 hidden · waiting on release/,
  );
});
