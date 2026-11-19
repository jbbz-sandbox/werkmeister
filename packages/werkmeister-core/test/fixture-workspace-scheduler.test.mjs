// Split from fixture-workspace.test.mjs so no one file holds most of the fixture tests (SW-881): what the fixture seeds for the scheduler and config.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { hostLoadLimit, readLeases } from "../dist/scheduler_state.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("config adds keys to the fixture's config.yaml, and any key but budget is refused (SW-670)", async () => {
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  await withFixtureWorkspace(
    async () => {
      assert.equal(hostLoadLimit(8), 0.01);
    },
    { config: { budget: { host_load: 0.01 } } },
  );
  for (const key of ["version", "paths", "overrides", "projects", "jira", "github_ingest"])
    assert.throws(() => fixturePreset({ config: { [key]: {} } }), /--config may not set/);
});

// SW-900: --workspace's keys land in workspace.yml from a pre-approved wrapper, so only listed ones pass.
test("fixturePreset refuses a --workspace key outside its allowlist and keeps the listed ones", async () => {
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  for (const key of ["feature", "services", "slot", "project", "bogus"])
    assert.throws(
      () => fixturePreset({ workspace: { [key]: "x" } }),
      new RegExp(`--workspace may not set ${key}: only `),
    );
  const listed = { group: ["SW-2"], context_strategy: "icm", work_type: "bugfix", repos: "app" };
  assert.deepEqual(fixturePreset({ workspace: listed }).workspace, listed);
});

test("containers and queue seed what the scheduler reads from Docker and queue.json (SW-685)", async () => {
  const { runningLeases } = await import("../dist/lifecycle.js");
  const { readQueue } = await import("../dist/scheduler_state.js");
  const holder = {
    feature: "holder",
    workspace: "holder-ws",
    startedAt: "2026-11-13T00:00:00Z",
    memory: 2 ** 30,
    nanoCpus: 6e9,
  };
  await withFixtureWorkspace(
    async (fx) => {
      assert.deepEqual(runningLeases(), [
        { feature: "holder", cost: { memory: 2 ** 30, cpus: 6 }, rank: "person", busy: false },
      ]);
      assert.ok(fs.statSync(path.join(fx.root, "ws", "holder-ws")).isDirectory());
      assert.deepEqual(readQueue(), ["a", "b"]);
    },
    { containers: [holder], queue: ["a", "b"] },
  );
  // SW-856: a 6th column, the running execs, reaches the scheduler as busy.
  await withFixtureWorkspace(async () => assert.equal(runningLeases()[0].busy, true), {
    containers: [{ ...holder, execs: 1 }],
  });
  await withFixtureWorkspace(async () => {
    assert.deepEqual(runningLeases(), []);
    assert.deepEqual(readQueue(), []);
  });
});

test("a queue entry with a wait seeds its lease, compose.yml and waiting.json (SW-809)", async () => {
  const { readQueue, waiters } = await import("../dist/scheduler_state.js");
  const { readWaiting } = await import("../dist/agent_state.js");
  await withFixtureWorkspace(
    async (fx) => {
      const before = Date.now();
      assert.deepEqual(readQueue(), ["head", "svc", "plain"]);
      const leases = readLeases();
      assert.equal(leases.head?.workspace, path.join(fx.root, "ws", "head"));
      assert.equal(leases.svc?.workspace, path.join(fx.root, "ws", "svc"));
      assert.equal(leases.plain, undefined, "a name-only entry seeds only its name");
      assert.notEqual(leases.head.slot, leases.svc.slot);
      assert.ok(fs.existsSync(path.join(leases.head.workspace, "compose.yml")));
      const head = readWaiting(leases.head.workspace);
      const waited = before - Date.parse(head.since);
      assert.ok(waited >= 239 * 60_000 && waited < 240 * 60_000, `waited ${waited} ms`);
      assert.equal(head.services, undefined);
      assert.deepEqual(readWaiting(leases.svc.workspace).services, ["api", "web"]);
      const [h, s, p] = waiters(readQueue(), []);
      assert.equal(Math.round(h.waitedMs / 60_000), 239);
      assert.ok(h.cost.cpus > 0, "a whole-feature head is priced from its compose.yml");
      assert.equal(s.gate, false);
      assert.equal(Math.round(s.waitedMs / 60_000), 3);
      assert.deepEqual(p, { feature: "plain", waitedMs: 0, gate: false });
    },
    { queue: ["head:239", "svc:3:api,web", "plain"] },
  );
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  for (const bad of [
    "head:",
    "head:-1",
    "head:1.5",
    "head:2:",
    "head:2:API",
    "head:2:a,,b",
    "head:2:a:b",
  ])
    assert.throws(() => fixturePreset({ queue: [bad] }), /--queue: bad entry/, bad);
});

test("a seed value that could leave the fixture or isn't a number is refused (SW-685)", async () => {
  const { fixturePreset } = await import("../dist/fixture_workspace.js");
  const ok = {
    feature: "h",
    workspace: "h",
    startedAt: "2026-11-13T00:00:00Z",
    memory: 0,
    nanoCpus: 1,
  };
  for (const bad of [
    { feature: "../x" },
    { workspace: "/etc" },
    { startedAt: "soon" },
    { memory: Number.NaN },
    { nanoCpus: -1 },
    { execs: 1.5 },
  ])
    assert.throws(() => fixturePreset({ containers: [{ ...ok, ...bad }] }), /--running: bad value/);
  assert.throws(() => fixturePreset({ queue: ["ok", "-x"] }), /--queue: bad entry "-x"/);
  assert.doesNotThrow(() => fixturePreset({ containers: [ok], queue: ["ok"] }));
});
