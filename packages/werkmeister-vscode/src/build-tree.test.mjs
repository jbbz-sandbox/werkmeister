import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeOf,
  buildTree,
  daemonDownNode,
  featureOf,
  interceptView,
  LEGEND_NODE,
  stripOf,
  TONE_COLORS,
  TOOLTIP_COMMANDS,
} from "../out/build-tree.js";

const ws = (name, over = {}) => ({
  name,
  path: `/ws/${name}`,
  vscodeUri: `vscode://file/ws/${name}`,
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

/**
 * An InterceptsResult-shaped object from a plain {feature: {service: row}} literal.
 * Every service in *spec* is remote unless *remote* says otherwise.
 */
const intercepts = (spec, remote = Object.values(spec).flatMap(Object.keys)) => ({
  available: true,
  installed: true,
  connectedNamespace: "default",
  remoteServices: new Set(remote),
  byFeature: new Map(
    Object.entries(spec).map(([feat, svcs]) => [
      feat,
      new Map(
        Object.entries(svcs).map(([svc, over]) => [
          svc,
          {
            feature: feat,
            service: svc,
            deployment: svc,
            interceptable: true,
            blocker: null,
            intercepted: false,
            intercepted_by: null,
            ...over,
          },
        ]),
      ),
    ]),
  ),
});

test("featureOf strips the werkmeister- compose prefix", () => {
  assert.equal(featureOf("werkmeister-tre-1125"), "tre-1125");
  assert.equal(featureOf("werkmeister-"), null);
  assert.equal(featureOf("something-else"), null);
  assert.equal(featureOf(null), null);
});

// serviceNode only looks up a row when feature is truthy, so interceptView never sees
// feature === null with a defined row under current code. This test guards against a
// future refactor of that ternary accidentally reintroducing a null-equals-null match.
test("a null feature with an intercepted row from an unknown source is not mine", () => {
  const result = interceptView(
    { intercepted: true, intercepted_by: null, blocker: null, interceptable: true },
    null,
    false,
    true,
  );
  assert.equal(result.contextValue, "service:intercepted-other");
  assert.equal(result.leave, false);
});

test("a fully running workspace reads as up", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "up", running: 6, total: 6, slot: 2 })],
    null,
    [],
  );
  assert.equal(node.kind, "workspace");
  assert.match(node.description, /6 of 6 up/);
  // Slot and ports are tooltip detail now, not card-face (SW-55).
  assert.doesNotMatch(node.description, /slot/);
  assert.match(node.tooltip, /slot 2/);
  assert.equal(node.contextValue, "workspace:up");
});

test("a partially running workspace reads as partial", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "partial", running: 2, total: 5 })],
    null,
    [],
  );
  assert.equal(node.contextValue, "workspace:partial");
  assert.match(node.description, /2 of 5 up/);
});

test("a down workspace shows no ratio", () => {
  const [node] = buildTree([ws("a")], [st("a")], null, []);
  assert.equal(node.contextValue, "workspace:down");
  assert.match(node.description, /down/);
});

test("an issue ID appears in the description and the node carries its URL", () => {
  const [node] = buildTree(
    [ws("a", { issueId: "PROJ-1125", issueUrl: "https://x/browse/PROJ-1125" })],
    [st("a")],
    null,
    [],
  );
  assert.match(node.description, /PROJ-1125/);
  assert.match(node.tooltip, /\[PROJ\\-1125\]\(https:\/\/x\/browse\/PROJ-1125\)/);
  assert.equal(node.workspace.issueUrl, "https://x/browse/PROJ-1125");
});

test("an interceptable service with no intercept offers the toggle", () => {
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
    intercepts({ a: { frontend: {} } }),
    [],
  );
  const [svc] = node.children;
  assert.equal(svc.kind, "service");
  assert.equal(svc.contextValue, "service:interceptable");
});

test("an intercept owned by this feature is mine", () => {
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
    intercepts({ a: { frontend: { intercepted: true, intercepted_by: "a" } } }),
    [],
  );
  assert.equal(node.children[0].contextValue, "service:intercepted-mine");
  assert.equal(node.children[0].service.leave, true);
});

// Only one intercept exists per Deployment; offering a --leave here would fail.
test("an intercept owned by another feature is not offered as mine", () => {
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
    intercepts({ a: { frontend: { intercepted: true, intercepted_by: "other" } } }),
    [],
  );
  const [svc] = node.children;
  assert.equal(svc.contextValue, "service:intercepted-other");
  assert.equal(svc.service.leave, false);
  assert.match(svc.tooltip, /other/);
});

test("a non-interceptable service surfaces the CLI blocker on hover", () => {
  const [node] = buildTree(
    [ws("a")],
    [
      st("a", {
        state: "up",
        running: 1,
        total: 1,
        services: [{ name: "postgres", state: "healthy" }],
      }),
    ],
    intercepts({ a: { postgres: { interceptable: false, blocker: "no k8s deployment" } } }),
    [],
  );
  assert.equal(node.children[0].contextValue, "service");
  assert.match(node.children[0].tooltip, /no k8s deployment/);
});

// A failed lookup must not silently read as "nothing here is interceptable".
test("a null intercepts payload marks every service unavailable", () => {
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
    null,
    [],
  );
  assert.equal(node.children[0].contextValue, "service");
  assert.match(node.children[0].tooltip, /intercept state unavailable/);
});

// Without telepresence the snapshot has no rows; that is "unavailable", not "not interceptable".
test("an unavailable telepresence marks every service unavailable", () => {
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
    { ...intercepts({}, ["frontend"]), available: false, installed: false },
    [],
  );
  assert.equal(node.children[0].contextValue, "service");
  assert.match(node.children[0].tooltip, /intercept state unavailable/);
});

// SW-12: installed but disconnected still offers the toggle; the CLI connects first.
test("a disconnected telepresence keeps interceptable services interceptable", () => {
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
    { ...intercepts({ a: { frontend: {} } }), available: false, connectedNamespace: null },
    [],
  );
  assert.equal(node.children[0].contextValue, "service:interceptable");
  assert.match(node.children[0].tooltip, /interceptable \(telepresence not connected\)/);
  const row = { interceptable: true, blocker: null, intercepted: false, intercepted_by: null };
  assert.equal(interceptView(row, "a", false, true).note, "interceptable");
});

// SW-21: a CLI or library is never a cluster service, so it gets no intercept state at all.
test("a local-only service shows no intercept state, connected or not", () => {
  const blocker =
    "has no k8s_deployment/k8s_namespace/k8s_port in services.yaml — not interceptable.";
  const row = { interceptable: false, blocker, intercepted: false, intercepted_by: null };
  assert.equal(interceptView(row, "a", false, false), null);
  assert.equal(interceptView(undefined, "a", true, false), null);
  for (const ix of [
    intercepts({ a: { cli: { interceptable: false, blocker } } }, []),
    { ...intercepts({}, []), available: false, installed: false },
    { ...intercepts({}, []), available: false },
  ]) {
    const [node] = buildTree(
      [ws("a")],
      [
        st("a", {
          state: "up",
          running: 1,
          total: 1,
          services: [{ name: "cli", state: "healthy" }],
        }),
      ],
      ix,
      [],
    );
    assert.equal(node.children[0].contextValue, "service");
    assert.equal(node.children[0].tooltip, "cli — healthy");
  }
});

test("the workspace containing the open folder is marked current and expanded", () => {
  const nodes = buildTree([ws("a"), ws("b")], [st("a"), st("b")], null, ["/ws/b/trustradius"]);
  const b = nodes.find((n) => n.label === "b");
  assert.match(b.description, /current/);
  assert.equal(b.expanded, true);
  // The suffix is what hides the switch button on the window's own workspace.
  assert.equal(b.contextValue, "workspace:down:current");
  assert.equal(nodes.find((n) => n.label === "a").contextValue, "workspace:down");
  assert.equal(nodes.find((n) => n.label === "a").expanded, false);
});

// Two workspaces could both be ancestors if one nested inside the other.
test("when several workspaces match the open folder, the deepest wins", () => {
  const nodes = buildTree(
    [ws("outer", { path: "/ws" }), ws("inner", { path: "/ws/inner" })],
    [st("outer"), st("inner")],
    null,
    ["/ws/inner/repo"],
  );
  assert.match(nodes.find((n) => n.label === "inner").description, /current/);
  assert.doesNotMatch(nodes.find((n) => n.label === "outer").description, /current/);
});

test("the current workspace sorts to the top, the rest keep their order", () => {
  const nodes = buildTree([ws("a"), ws("b"), ws("c")], [st("a"), st("b"), st("c")], null, [
    "/ws/c",
  ]);
  assert.deepEqual(
    nodes.map((n) => n.label),
    ["c", "a", "b"],
  );
});

// A multi-root .code-workspace often lists a tooling checkout first; the feature
// workspace is some later folder, and used to go unmarked.
test("any open folder, not just the first, marks its workspace current", () => {
  const nodes = buildTree([ws("b", { path: "/ws/b" })], [st("b")], null, [
    "/repos/sandbox",
    "/ws/b",
  ]);
  assert.match(nodes[0].description, /current/);
});

// A path prefix is not an ancestor: /ws/abc must not match workspace /ws/ab.
test("a sibling with a shared name prefix is not treated as the current workspace", () => {
  const nodes = buildTree([ws("ab", { path: "/ws/ab" })], [st("ab")], null, ["/ws/abc"]);
  assert.doesNotMatch(nodes[0].description, /current/);
});

test("a workspace missing from the status sweep renders as unknown", () => {
  const [node] = buildTree([ws("a")], [], null, []);
  assert.equal(node.contextValue, "workspace:unknown");
  assert.equal(node.icon.id, "question");
});

test("services are only listed when the status sweep found containers", () => {
  const [node] = buildTree([ws("a")], [st("a")], null, []);
  assert.deepEqual(node.children, []);
});

test("node ids are stable and unique", () => {
  const nodes = buildTree(
    [ws("a"), ws("b")],
    [
      st("a", { state: "up", running: 1, total: 1, services: [{ name: "svc", state: "healthy" }] }),
      st("b", { state: "up", running: 1, total: 1, services: [{ name: "svc", state: "healthy" }] }),
    ],
    null,
    [],
  );
  const ids = nodes.flatMap((n) => [n.id, ...n.children.map((c) => c.id)]);
  assert.equal(new Set(ids).size, ids.length);
});

// sandbox.switch puts the switched-to workspace first, so folder order — not
// path depth across folders — decides which one is marked current.
test("the first open folder's workspace wins over a deeper one further down", () => {
  const nodes = buildTree(
    [ws("a", { path: "/ws/a" }), ws("b", { path: "/ws/b/deeper" })],
    [st("a"), st("b")],
    null,
    ["/ws/a", "/ws/b/deeper"],
  );
  assert.match(nodes.find((n) => n.label === "a").description, /current/);
  assert.doesNotMatch(nodes.find((n) => n.label === "b").description, /current/);
});

// --- SW-55: the unified card spec ------------------------------------------

const NOW = new Date("2026-10-20T12:00:00Z");
const ago = (s) => new Date(NOW.getTime() - s * 1000).toISOString();
const pr = (repo, n, over = {}) => ({
  repo,
  branch: "b",
  url: `https://github.com/jbbz-stellwerk/${repo}/pull/${n}`,
  state: "OPEN",
  title: "t",
  labels: [],
  ci: null,
  failingChecks: 0,
  ...over,
});

/** The four rows of `docs/design/workspace-card/design/data.js` SAMPLE (minus `loading`). */
function sample() {
  const names = {
    143: "stellwerk-143-wizard-defaults",
    206: "stellwerk-206-pane-turn-state",
    151: "stellwerk-151-close-out-copy",
    bwell: "bwell",
  };
  const workspaces = Object.entries(names).map(([id, name]) =>
    ws(name, id === "bwell" ? {} : { issueId: `#${id}`, issueUrl: `https://x/issues/${id}` }),
  );
  const statuses = [
    st(names[143], {
      state: "stopped",
      total: 2,
      services: [
        { name: "cli", state: "down" },
        { name: "stellwerk-dashboard", state: "down" },
      ],
      claude: { state: "waiting" },
      ...ag("needs-you", ago(12 * 60), "ICM or JIT?"),
      stage: { index: 2, total: 4, name: "findings" },
    }),
    st(names[206], {
      state: "up",
      running: 2,
      total: 2,
      services: [
        { name: "cli", state: "healthy" },
        { name: "stellwerk-dashboard", state: "healthy" },
      ],
      claude: { state: "busy" },
      ...ag("working", null, null),
      lastActivity: ago(40),
      stage: { index: 4, total: 5, name: "implement" },
      autonomous: true,
    }),
    st(names[151], {
      state: "partial",
      running: 1,
      total: 2,
      services: [
        { name: "cli", state: "healthy" },
        { name: "stellwerk-dashboard", state: "unhealthy" },
      ],
      claude: { state: null },
      ...ag("done", ago(2 * 86400), null),
    }),
    st("bwell", { phase: "implement" }),
  ];
  const prs = new Map([
    [names[206], [pr("stellwerk", 231, { ci: "running", draft: true })]],
    [names[151], [pr("stellwerk", 186, { state: "MERGED", ci: "pass", release: "v0.14.0" })]],
    ["bwell", [pr("wellness", 12, { ci: "fail", failingChecks: 2 })]],
  ]);
  const lifecycles = new Map([[names[151], "shipped"]]);
  const nodes = buildTree(workspaces, statuses, null, [], { prs, lifecycles, now: NOW });
  return Object.fromEntries(Object.keys(names).map((id, i) => [id, nodes[i]]));
}

test("the tree matches VSCode Tree.dc.html for the sample data", () => {
  const n = sample();
  // The design's vsDesc, plus the issue ref the ticket's example adds.
  assert.equal(n[143].description, "● Needs you · 0 of 2 up · stage 2/4 · #143");
  assert.equal(n[206].description, "◌ Working · 2 of 2 up · stage 4/5 · #206 · ⚙ Auto");
  assert.equal(n[151].description, "✓ Done · 1 of 2 up · Ready to close out · #151");
  assert.equal(n.bwell.description, "Idle · down · JIT · implement");

  // SW-961: the card's stage bar; JIT and a shipped lifecycle have none.
  assert.deepEqual(n[143].card.pips, ["done", "current", "next", "next"]);
  assert.deepEqual(n[206].card.pips, ["done", "done", "done", "current", "next"]);
  assert.deepEqual(n[151].card.pips, []);
  assert.deepEqual(n.bwell.card.pips, []);

  assert.deepEqual(n[143].icon, { id: "circle-filled", color: "charts.yellow" });
  assert.deepEqual(n[206].icon, { id: "sync~spin", color: "charts.green" });
  assert.deepEqual(n[151].icon, { id: "pass", color: "charts.green" });
  assert.deepEqual(n.bwell.icon, { id: "circle-outline", color: "disabledForeground" });

  const prRows = (node) =>
    node.children
      .filter((c) => c.kind === "pr")
      .map((c) => [c.label, c.description, c.icon.id, c.icon.color]);
  assert.deepEqual(prRows(n[206]), [
    ["stellwerk#231", "Draft · CI running", "git-pull-request", "disabledForeground"],
  ]);
  assert.deepEqual(prRows(n[151]), [
    ["stellwerk#186", "Released v0.14.0 · CI ✓", "git-merge", "charts.purple"],
  ]);
  assert.deepEqual(prRows(n.bwell), [
    ["wellness#12", "Open · CI ✗ 2 failing", "git-pull-request", "charts.green"],
  ]);
  assert.equal(n.bwell.children[0].command, "sandbox.openPr");
  assert.deepEqual(n.bwell.workspace.prs, [
    { ref: "wellness#12", url: "https://github.com/jbbz-stellwerk/wellness/pull/12" },
  ]);

  const svc = n[151].children.find((c) => c.label === "stellwerk-dashboard");
  assert.deepEqual(svc.icon, { id: "warning", color: "errorForeground" });
});

test("the tooltip carries the card's rows, the needs list and the primary action", () => {
  const n = sample();
  const tip = n[143].tooltip;
  for (const row of ["**Containers**", "**PRs**", "**Workflow**", "**Agent**"]) {
    assert.ok(tip.includes(row), row);
  }
  assert.match(tip, /\*\*Workflow\*\* Stage 2 of 4 · findings/);
  assert.match(tip, /asked a question 12 min ago/);
  assert.match(tip, /> ● ICM or JIT\? · 12 min ago — Answer it/);
  assert.match(tip, /\[↗ Continue in Terminal\]\(command:sandbox\.continue\?/);
  assert.doesNotMatch(tip, /Autonomous/);

  assert.match(n[206].tooltip, /◌ Working · ⚙ Autonomous · last activity 40 s ago/);
  assert.doesNotMatch(n[206].tooltip, /> ●/, "needs are listed only when there are some");
  assert.match(n[151].tooltip, /\[✓ Close out\]\(command:sandbox\.closeOut\?/);
  assert.match(n.bwell.tooltip, /\[▶ Up\]\(command:sandbox\.up\?/);
  assert.match(n.bwell.tooltip, /no issue/);

  // Every link must be one tree.ts trusts, and carry the node shape pickWorkspace reads.
  for (const node of Object.values(n)) {
    for (const [, cmd, arg] of node.tooltip.matchAll(/command:([\w.]+)\?([^)]+)/g)) {
      assert.ok(TOOLTIP_COMMANDS.includes(cmd), cmd);
      assert.deepEqual(JSON.parse(decodeURIComponent(arg)), [
        { workspace: { name: node.workspace.name, path: node.workspace.path } },
      ]);
    }
  }
});

test("a failed PR fetch reads as PRs unavailable, not as none", () => {
  const [failed] = buildTree([ws("a")], [st("a")], null, [], { prs: null });
  assert.match(failed.tooltip, /\*\*PRs\*\* PRs unavailable/);
  const [none] = buildTree([ws("a")], [st("a")], null, [], { prs: new Map() });
  assert.match(none.tooltip, /\*\*PRs\*\* None yet/);
});

test("stopped and down read differently, though both are off", () => {
  const [stopped, down] = buildTree(
    [ws("a"), ws("b")],
    [st("a", { state: "stopped", total: 2 }), st("b")],
    null,
    [],
  );
  assert.equal(stopped.description, "Idle · 0 of 2 up");
  assert.equal(down.description, "Idle · down");
});

test("user text cannot inject Markdown into the tooltip", () => {
  const [node] = buildTree(
    [ws("a", { labels: ["[x](command:evil)"] })],
    [
      st("a", {
        claude: { state: null },
        ...ag("needs-you", null, "*bold* [y](http://z)"),
      }),
    ],
    null,
    [],
  );
  assert.doesNotMatch(node.tooltip, /\]\(command:evil/);
  assert.match(node.tooltip, /\\\[x\\\]\\\(command:evil\\\)/);
  assert.match(node.tooltip, /\\\*bold\\\* \\\[y\\\]\\\(http:/);
});

test("colours come from the board 09 tone map only", () => {
  assert.deepEqual(TONE_COLORS, {
    ok: "charts.green",
    warn: "charts.yellow",
    err: "errorForeground",
    off: "disabledForeground",
    pr: "charts.purple",
    needs: "charts.yellow",
  });
  const colours = new Set(Object.values(TONE_COLORS));
  const n = sample();
  const all = Object.values(n).flatMap((w) => [w, ...w.children]);
  for (const node of [...all, LEGEND_NODE, ...LEGEND_NODE.children]) {
    if (node.icon.color) assert.ok(colours.has(node.icon.color), `${node.id}: ${node.icon.color}`);
  }
});

test("the legend names every agent state, the service marks and autonomous", () => {
  const labels = LEGEND_NODE.children.map((c) => c.label);
  for (const word of ["Needs you", "Working", "Done", "Idle", "⚙ Auto"]) {
    assert.ok(labels.includes(word), word);
  }
  assert.ok(LEGEND_NODE.children.some((c) => /○ down/.test(c.description)));
  assert.equal(LEGEND_NODE.contextValue, "legend");
});

test("SW-41: CPU and memory join the row by compose project; the start reason is in the hover", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const [node] = buildTree(
    [ws("a")],
    [
      st("a", {
        state: "up",
        running: 1,
        total: 1,
        services: [{ name: "api", state: "running" }],
        started: { at: "2026-10-20T10:00:00Z", by: "gate" },
        crashLoops: [],
      }),
    ],
    null,
    [],
    { now, usage: { "werkmeister-a": { cpuPercent: 12.3, memMib: 410 } } },
  );
  assert.match(node.description, /1 of 1 up · 12\.3% CPU · 410 MiB/);
  assert.match(node.tooltip, /\*\*Resources\*\* 12\\\.3% CPU · 410 MiB · started 2 h ago by gate/);
  assert.doesNotMatch(node.tooltip, /\*\*Crash\*\*/);
});

test("SW-41: a crash loop reads as an error on the row and the service, with the last log line", () => {
  const [node] = buildTree(
    [ws("a")],
    [
      st("a", {
        state: "up",
        running: 2,
        total: 2,
        services: [
          { name: "api", state: "running" },
          { name: "web", state: "healthy" },
        ],
        started: null,
        crashLoops: [{ service: "api", restarts: 7, lastLog: "Error: EADDRINUSE" }],
      }),
    ],
    null,
    [],
  );
  assert.match(node.description, /api crash-looping/);
  assert.doesNotMatch(node.description, /2 of 2 up/, "a crash loop no longer hides behind up");
  assert.match(
    node.tooltip,
    /\*\*Crash\*\* ✗ api crash\\-looping · 7 restarts · Error: EADDRINUSE/,
  );
  const [api, web] = node.children;
  assert.deepEqual(api.icon, { id: "error", color: TONE_COLORS.err });
  assert.equal(web.icon.color, TONE_COLORS.ok);
});

test("SW-1009: the host line moved to the strip; no host row leads the tree", () => {
  const host = { load: [401, 380, 300], cores: 10, featureCpuPercent: 845.2 };
  const nodes = buildTree([ws("a")], [st("a")], null, [], { host });
  assert.deepEqual(
    nodes.map((n) => n.id),
    ["a"],
  );
  const s = stripOf(nodes, [st("a")], { host });
  assert.equal(s.host.text, "host 4010% · features 8.5 of 10 cores");
  assert.equal(s.host.tone, "warn", "load past the core count warns");
  assert.equal(stripOf(nodes, [st("a")], { host: null }).host.text, "host n/a");
  assert.equal(stripOf(nodes, [st("a")]).host, null, "no sweep yet, no host line");
});

// SW-1010: plugins/werkmeister/hooks/register.test.ts mounts the pane on this snapshot and expects the same text.
test("SW-1010: stripOf reads the same chips and host as the /workspaces pane for one snapshot", () => {
  const statuses = [
    st("ab", { state: "up", running: 3, total: 3, ...ag("working") }),
    st("abc", { state: "partial", running: 1, total: 3, ...ag("needs-you", null, "Which port?") }),
    st("empty", ag("idle")),
  ];
  const extra = {
    host: { load: [3.2, 2.8, 2.1], cores: 10, featureCpuPercent: 45 },
    infra: {
      state: "partial",
      services: [
        { name: "registry", state: "healthy" },
        { name: "caddy", state: "down" },
      ],
    },
    prs: new Map([
      [
        "ab",
        [
          {
            url: "https://github.com/o/sandbox/pull/12",
            state: "OPEN",
            ci: null,
            failingChecks: 0,
            mergeable: "CONFLICTING",
          },
        ],
      ],
    ]),
  };
  const nodes = buildTree(
    ["ab", "abc", "empty"].map((n) => ws(n)),
    statuses,
    null,
    [],
    extra,
  );
  const s = stripOf(nodes, statuses, extra);
  assert.equal(
    s.chips.map((c) => c.text).join("  "),
    "● 1 needs you  2 running  infra: caddy down  1 CI failed or conflicts",
  );
  assert.equal(s.host.text, "host 32% · features 0.5 of 10 cores");
});

// SW-184: every Docker read goes through the host daemon, so a daemon that is
// down is its own row with its own fix, not "could not find the CLI".
test("a daemon that is down is an error row naming setup and connect", () => {
  const node = daemonDownNode("werkmeister daemon not reachable at http://127.0.0.1:3002");
  assert.equal(node.kind, "error");
  assert.equal(node.label, "werkmeister daemon not running");
  assert.match(node.description, /setup.*connect/);
  assert.match(node.tooltip, /127\.0\.0\.1:3002/);
  assert.deepEqual(node.children, []);
});

// SW-818: a PR opened after the view loaded stayed hidden until ↻ Refresh PRs.
test("prFilesKey: changes when a PR file gains a url or a new status, so the view refetches PRs", async () => {
  const { prFilesKey } = await import("../out/build-tree.js");
  const draft = new Map([["a", [{ dir: "werkmeister", status: "draft", url: null }]]]);
  const open = new Map([
    ["a", [{ dir: "werkmeister", status: "open", url: "https://github.com/o/r/pull/892" }]],
  ]);
  assert.equal(prFilesKey(draft), prFilesKey(new Map(draft)));
  assert.notEqual(prFilesKey(draft), prFilesKey(open));
});

// SW-558: the card lists every need, the PR poll's too, and the phase past building, as the pane does.
test("card: the phase, the activity and every need, PR items included", () => {
  const need = (id, what, source = "gate") => ({
    id,
    kind: "gate",
    what,
    since: null,
    action: "Read it",
    source,
  });
  const state = {
    phase: { id: "pr-open", label: "PR open", stage: null },
    activity: { id: "testing", label: "Running tests", since: null, session: "s" },
    needs: [need("gate:a", "Approve a.md"), need("question:s", "Ship?", "text")],
    agent: { id: "needs-you", since: null },
  };
  const prNeeds = new Map([
    ["a", { prNeeds: [need("ci-failed:r", "CI failed on r#1", "pr")], phaseDetail: "behind main" }],
  ]);
  const [node] = buildTree([ws("a")], [st("a", { workspaceState: state })], null, [], { prNeeds });
  assert.equal(node.card.phase, "PR open · behind main");
  assert.equal(node.card.activity.text, "Running tests");
  assert.deepEqual(node.card.needs, [
    "● Approve a.md — Read it",
    "● Ship? (guess) — Read it",
    "● CI failed on r#1 — Read it",
  ]);
  assert.equal(node.card.needsYou, true);
  const building = {
    ...state,
    phase: { id: "building", label: "Stage 2 of 4 · spec", stage: null },
  };
  const [b] = buildTree([ws("a")], [st("a", { workspaceState: building })], null, []);
  assert.equal(b.card.phase, null, "while building, meta already shows the stage");
});

// SW-953: one state word per card; the line under it is that state's detail.
test("card: one state word, its activity a detail (sw-852's Thinking, sw-891's Done)", () => {
  const hAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const card = (activity, agent) =>
    buildTree(
      [ws("a")],
      [
        st("a", {
          workspaceState: {
            phase: { id: "building", label: "", stage: null },
            activity,
            needs: [],
            agent,
          },
        }),
      ],
      null,
      [],
      { now: NOW },
    )[0].card;
  const quiet = card(
    { id: "thinking", label: "Thinking", since: hAgo(6), session: "s" },
    { id: "working", since: hAgo(6) },
  );
  assert.equal(quiet.state, "◌ Working");
  assert.deepEqual(quiet.activity, {
    text: "Thinking · last heard 6 h ago",
    color: TONE_COLORS.off,
  });
  const done = card(
    { id: "idle", label: "Idle", since: null, session: null },
    { id: "done", since: hAgo(1) },
  );
  assert.equal(done.state, "✓ Done");
  assert.equal(done.activity, null);
});

// SW-1022: the view badge's tooltip takes the strip chip's need/needs rule.
test("the view badge counts the needs chip and reads `1 needs you` for one", () => {
  const strip = (count) => ({
    chips: count ? [{ kind: "needs", count, text: "", tone: "needs", first: null }] : [],
    host: null,
  });
  assert.deepEqual(badgeOf(strip(1)), { value: 1, tooltip: "1 needs you" });
  assert.deepEqual(badgeOf(strip(3)), { value: 3, tooltip: "3 need you" });
  assert.equal(badgeOf(strip(0)), undefined);
});
