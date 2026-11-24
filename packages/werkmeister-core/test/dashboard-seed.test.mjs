// SW-1092: `workspace serve --dashboard` seeds a temp HOME and runs the dashboard under an env built
// from nothing, so a browser check sees seed data and no click reaches the host.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  dashboardServeEnv,
  findDashboardBundle,
  SEEDED_STATES,
  STUBBED_BINS,
  seedDashboardHome,
} from "../dist/dashboard_seed.js";
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
