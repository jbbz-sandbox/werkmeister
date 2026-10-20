import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTree,
  featureOf,
  interceptView,
  LEGEND_NODE,
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

const st = (name, over = {}) => ({
  name,
  project: `sandbox-${name}`,
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

/**
 * An InterceptsResult-shaped object from a plain {feature: {service: row}} literal.
 * Every service in *spec* is remote unless *remote* says otherwise.
 */
const intercepts = (spec, remote = Object.values(spec).flatMap(Object.keys)) => ({
  available: true,
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

test("featureOf strips the sandbox- compose prefix", () => {
  assert.equal(featureOf("sandbox-tre-1125"), "tre-1125");
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
    { ...intercepts({}, ["frontend"]), available: false },
    [],
  );
  assert.equal(node.children[0].contextValue, "service");
  assert.match(node.children[0].tooltip, /intercept state unavailable/);
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
      claude: { state: "waiting", agent: "needs-you", at: ago(12 * 60), question: "ICM or JIT?" },
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
      claude: { state: "busy", agent: "working", at: null, question: null },
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
      claude: { state: null, agent: "done", at: ago(2 * 86400), question: null },
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

test("the tooltip carries the card's rows, the question and the primary action", () => {
  const n = sample();
  const tip = n[143].tooltip;
  for (const row of ["**Containers**", "**PRs**", "**Workflow**", "**Agent**"]) {
    assert.ok(tip.includes(row), row);
  }
  assert.match(tip, /\*\*Workflow\*\* Stage 2 of 4 · findings/);
  assert.match(tip, /asked a question 12 min ago/);
  assert.match(tip, /> “ICM or JIT\?”/);
  assert.match(tip, /\[↗ Continue in Terminal\]\(command:sandbox\.continue\?/);
  assert.doesNotMatch(tip, /Autonomous/);

  assert.match(n[206].tooltip, /◌ Working · ⚙ Autonomous · last activity 40 s ago/);
  assert.doesNotMatch(n[206].tooltip, /> “/, "the question is shown only for Needs you");
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
        claude: { state: null, agent: "needs-you", at: null, question: "*bold* [y](http://z)" },
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
    { now, usage: { "sandbox-a": { cpuPercent: 12.3, memMib: 410 } } },
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

test("SW-41: the host row leads once a sweep has landed, and only then", () => {
  const host = { load: [401, 380, 300], cores: 10, featureCpuPercent: 845.2 };
  const [first, second] = buildTree([ws("a")], [st("a")], null, [], { host });
  assert.equal(first.kind, "host");
  assert.equal(first.description, "load 401 · 380 · 300 / 10 cores · features 845.2% CPU");
  assert.equal(first.icon.color, TONE_COLORS.warn, "load past the core count warns");
  assert.equal(second.id, "a");
  const failed = buildTree([ws("a")], [st("a")], null, [], { host: null });
  assert.equal(failed[0].description, "load n/a");
  assert.equal(buildTree([ws("a")], [st("a")], null, [])[0].id, "a", "no sweep yet, no row");
});
