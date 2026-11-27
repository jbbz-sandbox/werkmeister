// SW-1092: `workspace serve --dashboard` seeds a temp HOME and runs the dashboard under an env built
// from nothing, so a browser check sees seed data and no click reaches the host.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  dashboardContainerArgs,
  dashboardServeEnv,
  deadDashboardRuns,
  findDashboardBundle,
  SEEDED_STATES,
  STUBBED_BINS,
  seedDashboardHome,
} from "../dist/dashboard_seed.js";
import { flowMetrics, trendSeries } from "../dist/metrics_report.js";
import { lifecycleOf } from "../dist/pr_lifecycle.js";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js").default;
const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../docs/superpowers/specs/2026-11-15-metrics-events.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({
  formats: { "date-time": (s) => !Number.isNaN(Date.parse(s)), uri: (s) => URL.canParse(s) },
}).compile(schema);

const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const under = (root, p) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

test("the seed writes only under HOME: a schema-valid event log, every lifecycle state, transcripts", () => {
  const home = tmp("dashboard-seed-");
  const written = seedDashboardHome(home);
  assert.ok(written.length > 0);
  for (const p of written) assert.ok(under(home, p), `${p} is outside ${home}`);

  const metrics = path.join(home, ".werkmeister", "metrics");
  const lines = fs
    .readdirSync(metrics)
    .flatMap((f) => fs.readFileSync(path.join(metrics, f), "utf8").trim().split("\n"));
  assert.ok(lines.length >= 20);
  for (const l of lines)
    assert.ok(validate(JSON.parse(l)), `${l}: ${JSON.stringify(validate.errors)}`);

  const root = path.join(home, "ws");
  const names = fs.readdirSync(root);
  assert.deepEqual(
    new Set(names.map((n) => lifecycleOf(path.join(root, n)).state)),
    new Set(SEEDED_STATES),
  );
  for (const n of names) {
    const project = path.join(
      home,
      ".claude",
      "projects",
      path.join(root, n).replace(/[^a-zA-Z0-9]/g, "-"),
    );
    assert.equal(fs.readdirSync(project).filter((f) => f.endsWith(".jsonl")).length, 2, n);
  }
  for (const bin of STUBBED_BINS) fs.accessSync(path.join(home, "bin", bin), fs.constants.X_OK);
});

test("the dashboard env has exactly the allowlisted keys, every path under HOME", () => {
  const home = tmp("dashboard-env-");
  const env = dashboardServeEnv(home, 4321, {
    LANG: "C",
    GH_TOKEN: "x",
    JIRA_API_TOKEN: "x",
    NODE_OPTIONS: "--require /x",
    PATH: "/usr/bin",
    HOME: "/Users/real",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "CLAUDE_BIN",
    "CODEX_BIN",
    "DOCKER_HOST",
    "GIT_CEILING_DIRECTORIES",
    "HOME",
    "HOST",
    "LANG",
    "OPENCODE_BIN",
    "PATH",
    "PORT",
    "TMPDIR",
    "VSCODE_BIN",
    "WERKMEISTER_BIN",
    "WERKMEISTER_CONFIG_FILE",
    "WERKMEISTER_DASHBOARD_PORT",
    "WERKMEISTER_DOCKER_BIN",
    "WERKMEISTER_FIXTURE",
    "WERKMEISTER_GH_BIN",
    "WERKMEISTER_HOST",
    "WERKMEISTER_MCP_PORT",
    "WERKMEISTER_TEMP_HOME",
    "WERKMEISTER_WORKSPACES_ROOT",
  ]);
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(
    dashboardServeEnv(home, 4321, {}, "0.0.0.0").HOST,
    "0.0.0.0",
    "a container binds all",
  );
  assert.equal(env.PORT, "4321");
  assert.equal(env.PATH, path.join(home, "bin"));
  assert.equal(env.WERKMEISTER_HOST, "http://127.0.0.1:65535");
  assert.equal(env.WERKMEISTER_DASHBOARD_PORT, "4321");
  for (const k of ["HOME", "TMPDIR", "WERKMEISTER_CONFIG_FILE", "WERKMEISTER_WORKSPACES_ROOT"])
    assert.ok(under(home, env[k]), k);
  for (const k of [
    "WERKMEISTER_DOCKER_BIN",
    "WERKMEISTER_GH_BIN",
    "WERKMEISTER_BIN",
    "CLAUDE_BIN",
    "VSCODE_BIN",
  ])
    assert.ok(under(path.join(home, "bin"), env[k]), k);
  assert.ok(under(home, env.DOCKER_HOST.replace(/^unix:\/\//, "")));
});

test("findDashboardBundle wants exactly one built werkmeister worktree", () => {
  const ws = tmp("dashboard-ws-");
  assert.match(findDashboardBundle(ws).error, /No werkmeister worktree/);
  const worktree = (name, pkg = "werkmeister") => {
    fs.mkdirSync(path.join(ws, name, "apps", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, name, "apps", "cli", "package.json"),
      JSON.stringify({ name: pkg }),
    );
    return path.join(ws, name, "apps", "cli", "dist");
  };
  worktree("other-app", "something-else");
  const dist = worktree("werkmeister");
  assert.match(findDashboardBundle(ws).error, /no built dashboard/);
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "dashboard.js"), "");
  fs.writeFileSync(path.join(dist, "browser.html"), "");
  assert.deepEqual(findDashboardBundle(ws), { entry: path.join(dist, "dashboard.js") });
  worktree("werkmeister-2");
  assert.match(findDashboardBundle(ws).error, /More than one/);
});

test("WERKMEISTER_DASHBOARD_PORT moves the dashboard port tools health-check; unset is 3001", async () => {
  const { DASHBOARD } = await import("../dist/web_servers.js");
  const before = process.env.WERKMEISTER_DASHBOARD_PORT;
  try {
    delete process.env.WERKMEISTER_DASHBOARD_PORT;
    assert.equal(DASHBOARD.port, 3001);
    process.env.WERKMEISTER_DASHBOARD_PORT = "4321";
    assert.equal(DASHBOARD.port, 4321);
    process.env.WERKMEISTER_DASHBOARD_PORT = "nope";
    assert.equal(DASHBOARD.port, 3001);
  } finally {
    if (before === undefined) delete process.env.WERKMEISTER_DASHBOARD_PORT;
    else process.env.WERKMEISTER_DASHBOARD_PORT = before;
  }
});

test("bin/node links to the node it is given: the image's in a container (SW-1135)", () => {
  const home = tmp("dashboard-node-");
  seedDashboardHome(home, Date.now(), "/usr/local/bin/node");
  assert.equal(fs.readlinkSync(path.join(home, "bin", "node")), "/usr/local/bin/node");
});

test("the container mounts only dist read-only and the seeded HOME: no docker socket, no ~/.werkmeister (SW-1135)", () => {
  // Read before anything moves HOME: the real one is what must never be mounted.
  const realWerkmeister = path.join(os.homedir(), ".werkmeister");
  const home = tmp("dashboard-ctr-");
  const dist = path.join(tmp("dashboard-dist-"), "apps", "cli", "dist");
  const run = dashboardContainerArgs({
    name: "wm-seeded-1",
    dist,
    home,
    port: 4321,
    host: "mac-1",
    uid: 501,
    gid: 20,
    env: dashboardServeEnv(home, 4321, {}, "0.0.0.0"),
  });
  const values = (argv, flag) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));

  assert.deepEqual(values(run.app, "-v"), [`${dist}:${dist}:ro`, `${home}:${home}`]);
  assert.deepEqual(values(run.forwarder, "-v"), []);
  assert.deepEqual(values(run.app, "--mount"), []);
  for (const a of [...run.app, ...run.forwarder]) {
    // The seeded HOME's DOCKER_HOST is its own dead no-docker.sock; a real socket is named docker.sock.
    assert.doesNotMatch(a, /\/docker\.sock|\/var\/run/, a);
    assert.ok(!a.includes(realWerkmeister), `${a} reaches ${realWerkmeister}`);
  }
  // Loopback only, and only through the forwarder: the dashboard publishes nothing.
  assert.deepEqual(values(run.app, "-p"), []);
  assert.deepEqual(values(run.forwarder, "-p"), ["127.0.0.1:4321:4321"]);
  // Alone on an internal network: no route to the host's daemon or the internet.
  assert.deepEqual(values(run.app, "--network"), ["wm-seeded-1"]);
  assert.deepEqual(run.network.slice(0, 3), ["network", "create", "--internal"]);
  assert.equal(run.network.at(-1), "wm-seeded-1");
  for (const f of ["--read-only", "--init", "--rm"]) assert.ok(run.app.includes(f), f);
  // Created, then attached by serve: a detached app that crashes takes its log with it (--rm).
  assert.equal(run.app[0], "create");
  // Each part names the host that made it: a reaper in another pid namespace must not judge it.
  for (const argv of [run.network, run.app, run.forwarder])
    assert.ok(argv.includes("werkmeister.seeded-dashboard.host=mac-1"), argv.join(" "));
  assert.deepEqual(run.attach, ["start", "-a", "wm-seeded-1-app"]);
  assert.deepEqual(values(run.app, "--cap-drop"), ["ALL"]);
  assert.deepEqual(values(run.app, "--user"), ["501:20"]);
  assert.ok(run.app.includes("node:22") && run.forwarder.includes("node:22"));
  // node by path: the seeded PATH holds only stubs, so the image's entrypoint would not be found.
  assert.deepEqual(run.app.slice(-4), [
    "--entrypoint",
    "/usr/local/bin/node",
    "node:22",
    path.join(dist, "dashboard.js"),
  ]);
  assert.deepEqual(run.teardown, [
    ["rm", "-f", "wm-seeded-1-app", "wm-seeded-1-fwd"],
    ["network", "rm", "wm-seeded-1"],
  ]);
});

test("only runs whose serve pid is gone are reaped, each once; other labels are ignored (SW-1135)", () => {
  const labels = [
    "werkmeister-seeded-dashboard-111-5000", // dead: app container
    "werkmeister-seeded-dashboard-111-5000", // dead: fwd container
    "werkmeister-seeded-dashboard-222-5001", // live serve
    "werkmeister-seeded-dashboard-111-5000", // dead: network
    "someone-else-111-5000",
    "",
  ].join("\n");
  assert.deepEqual(
    deadDashboardRuns(labels, (pid) => pid === 222),
    ["werkmeister-seeded-dashboard-111-5000"],
  );
});

test("the seed's gates fill the Metrics tab's gate and test charts, pkg-b slower in the last complete week (SW-1101)", () => {
  const home = tmp("dashboard-seed-");
  try {
    seedDashboardHome(home);
    const metrics = path.join(home, ".werkmeister", "metrics");
    const events = fs
      .readdirSync(metrics)
      .flatMap((f) => fs.readFileSync(path.join(metrics, f), "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l));
    const t = trendSeries({ events, open: [], usages: [] }, "90d", "week", new Date());
    assert.deepEqual(Object.keys(t.suites).sort(), ["pkg-a", "pkg-b", "pkg-c"]);
    const done = t.rows.slice(0, -1);
    const latest = done.at(-1);
    assert.equal(latest.tests["pkg-b"].p50Minutes, 5.1);
    assert.ok(latest.tests["pkg-c"].cached > 0, "pkg-c is partly cached");
    for (const r of done.slice(-5, -1)) assert.equal(r.tests["pkg-b"].p50Minutes, 3.1);
    assert.ok(t.rows.some((r) => r.gate.byKind.lint > 0 && r.gate.byKind.setup > 0));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the seed types its runs with two work types, one with enough merged runs for its own p90 (SW-1212)", () => {
  const home = tmp("dashboard-seed-");
  try {
    seedDashboardHome(home);
    const metrics = path.join(home, ".werkmeister", "metrics");
    const events = fs
      .readdirSync(metrics)
      .flatMap((f) => fs.readFileSync(path.join(metrics, f), "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l));
    const created = events.filter((e) => e.event === "workspace.create").map((e) => e.work_type);
    assert.ok(new Set(created).size >= 2, `create lines' types: ${created}`);
    const root = path.join(home, "ws");
    const ymlTypes = fs
      .readdirSync(root)
      .map((n) => fs.readFileSync(path.join(root, n, ".werkmeister", "workspace.yml"), "utf8"))
      .map((y) => /^work_type: (\S+)$/m.exec(y)?.[1]);
    assert.ok(ymlTypes.every(Boolean) && new Set(ymlTypes).size >= 2);
    const usages = fs.readdirSync(root).flatMap((n) => {
      const f = path.join(root, n, "usage.json");
      return fs.existsSync(f) ? [JSON.parse(fs.readFileSync(f, "utf8"))] : [];
    });
    const r = flowMetrics({ events, open: [], usages }, "30d", new Date());
    assert.deepEqual([r.byWorkType.feature.runs, r.byWorkType.feature.fewRuns], [5, false]);
    assert.ok(Object.keys(r.byWorkType).length >= 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
