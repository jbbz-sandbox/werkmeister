// SW-775: the metrics event log, and queue.wait / queue.admit at admission. Every line is checked against the schema.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { test } from "node:test";

import { sandboxHome } from "../dist/config.js";
import { metricsPath, recordEvent } from "../dist/metrics.js";
import { defaultDeps, gatePrs, openPrs, refreshPrStatus } from "../dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { requestAdmission } from "../dist/scheduler_state.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

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
// ajv-formats isn't a core dependency, and without a format ajv only warns and skips `at`.
const validate = new Ajv2020({
  formats: { "date-time": (s) => !Number.isNaN(Date.parse(s)), uri: (s) => URL.canParse(s) },
}).compile(schema);

const G = 2 ** 30;
const BUDGET = { memory: G, cpus: 4, preempt: true };
const FULL = [{ feature: "x", cost: { memory: G, cpus: 1 }, rank: "idle", busy: false }];
const COMPOSE =
  "services:\n  api:\n    deploy:\n      resources:\n        reservations: { memory: 512M }\n";

/** Every line in this month's log, each asserted valid against the schema. */
function lines() {
  const file = metricsPath(new Date().toISOString());
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  return text
    .trimEnd()
    .split("\n")
    .map((l) => {
      const o = JSON.parse(l);
      assert.ok(validate(o), JSON.stringify(validate.errors));
      return o;
    });
}

function workspace(fx, name) {
  const ws = path.join(fx.root, "ws", name);
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(ws, "compose.yml"), COMPOSE);
  return ws;
}

test("the schema's own examples pass the validator", () => {
  for (const e of schema.examples) assert.ok(validate(e), JSON.stringify(validate.errors));
});

test("recordEvent appends one line to the event's month under the temp sandboxHome", async () => {
  await withFixtureWorkspace(async (fx) => {
    const dir = path.join(sandboxHome(), "metrics");
    assert.ok(dir.startsWith(fx.root), `${dir} is outside the fixture`);
    const e = { event: "queue.wait", workspace: "w", feature: "f", position: 1 };
    recordEvent(e, "2026-11-30T23:59:59.000Z");
    recordEvent(e, "2026-11-30T23:59:59.500Z");
    recordEvent(
      { ...e, event: "queue.admit", position: undefined, waited_s: 1 },
      "2026-12-01T00:00:00.000Z",
    );
    assert.deepEqual(fs.readdirSync(dir).sort(), ["events-2026-11.jsonl", "events-2026-12.jsonl"]);
    const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n");
    const [nov, dec] = [read("events-2026-11.jsonl"), read("events-2026-12.jsonl")];
    assert.deepEqual([nov.length, dec.length], [3, 2], "one line per event, each newline-ended");
    for (const l of [...nov, ...dec].filter(Boolean))
      assert.ok(validate(JSON.parse(l)), JSON.stringify(validate.errors));
  });
});

test("a capacity wait writes one queue.wait however often it re-asks, then one queue.admit", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const ws = workspace(fx, "mine");
      assert.equal((await requestAdmission("mine", ws, false, FULL, BUDGET)).kind, "wait");
      assert.equal((await requestAdmission("mine", ws, false, FULL, BUDGET)).kind, "wait");
      assert.deepEqual(await requestAdmission("mine", ws, false, [], BUDGET), { kind: "admit" });
      const [wait, admit, ...rest] = lines();
      assert.deepEqual(rest, []);
      assert.deepEqual(
        { ...wait, at: undefined },
        {
          v: 1,
          at: undefined,
          event: "queue.wait",
          workspace: "mine",
          feature: "mine",
          position: 1,
        },
      );
      assert.equal(admit.event, "queue.admit");
      assert.equal(admit.feature, "mine");
      assert.ok(admit.waited_s >= 0 && admit.waited_s < 60);
    },
    { slotsFull: true },
  );
});

test("an admit times the wait from waiting.json's since; no waiting.json, no line", async () => {
  // The fixture seeds `head` with a waiting.json 5 min old (SW-809).
  await withFixtureWorkspace(
    async (fx) => {
      const head = path.join(fx.root, "ws", "head");
      assert.deepEqual(await requestAdmission("head", head, false, [], BUDGET), { kind: "admit" });
      const [admit, ...rest] = lines();
      assert.deepEqual(rest, []);
      assert.equal(admit.event, "queue.admit");
      assert.ok(admit.waited_s >= 299 && admit.waited_s <= 301, `waited_s ${admit.waited_s}`);
    },
    { queue: ["head:5"] },
  );
  await withFixtureWorkspace(async (fx) => {
    const fresh = workspace(fx, "fresh");
    assert.deepEqual(await requestAdmission("fresh", fresh, false, [], BUDGET), { kind: "admit" });
    assert.deepEqual(lines(), []);
  });
});

test("never-fits clears a wait without an admit line", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const head = path.join(fx.root, "ws", "head");
      const tiny = { memory: G / 4, cpus: 0.5, preempt: true };
      assert.equal((await requestAdmission("head", head, false, [], tiny)).kind, "never-fits");
      assert.deepEqual(lines(), []);
    },
    { queue: ["head:5"] },
  );
});

// SW-779: pr.open and pr.merged carry GitHub's createdAt / mergedAt, here the fake gh's fixed 2026-01 times.
test("pr open then pr status write pr.open and pr.merged at the fake gh's times", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      await refreshPrStatus(fx.workspace);
      await refreshPrStatus(fx.workspace);
      const file = metricsPath("2026-01");
      assert.ok(file.startsWith(fx.root), `${file} is outside the fixture`);
      const got = fs
        .readFileSync(file, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => {
          const o = JSON.parse(l);
          assert.ok(validate(o), JSON.stringify(validate.errors));
          return [o.event, o.at, o.workspace, o.pr];
        });
      const ws = path.basename(fx.workspace);
      const pr = "https://github.com/o/app/pull/1";
      assert.deepEqual(got, [
        ["pr.open", "2026-01-02T03:04:05.000Z", ws, pr],
        ["pr.merged", "2026-01-02T04:05:06.000Z", ws, pr],
      ]);
    },
    { gate: true, merged: true },
  );
});

// SW-778: gate.start / gate.end around each runGate, retry counting the workspace's gate runs.

/** Inits the fixture workspace, then runs `gatePrs` once per deps; returns the gate.* lines and each result. */
async function gateRuns(fx, ...depsList) {
  assert.ok(
    metricsPath(new Date().toISOString()).startsWith(process.env.HOME),
    "metrics outside temp HOME",
  );
  await withReporter(collectingReporter(), () => initWorkspace({}, fx.workspace, { build: false }));
  const results = [];
  for (const deps of depsList) results.push(await gatePrs(fx.workspace, undefined, deps));
  const gates = lines().filter((l) => l.event.startsWith("gate."));
  for (const g of gates) assert.equal(g.workspace, path.basename(fx.workspace));
  return { gates, results };
}

test("a gate run writes one gate.start (retry 0) and one gate.end (exit 0) sharing a run id", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const { gates, results } = await gateRuns(fx, defaultDeps());
      assert.equal(results[0].ok, true, results[0].lines.join("\n"));
      const [start, end, ...rest] = gates;
      assert.deepEqual(rest, []);
      assert.deepEqual(
        [start.event, start.retry, end.event, end.exit],
        ["gate.start", 0, "gate.end", 0],
      );
      assert.equal(start.run, end.run);
      assert.ok(end.at >= start.at);
    },
    { gate: true },
  );
});

test("an exit-75 gate writes exit 75, and the next run in the workspace has retry 1", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      // defaultDeps() reads the fixture's registry, so it is built inside the fixture.
      const lowMemory = { ...defaultDeps(), hostMemory: () => ({ free: 1, total: 16 * 2 ** 30 }) };
      const { gates, results } = await gateRuns(fx, lowMemory, defaultDeps());
      assert.equal(results[0].retry, true, results[0].lines.join("\n"));
      assert.equal(results[1].ok, true, results[1].lines.join("\n"));
      assert.deepEqual(
        gates.map((g) => [g.event, g.retry ?? g.exit]),
        [
          ["gate.start", 0],
          ["gate.end", 75],
          ["gate.start", 1],
          ["gate.end", 0],
        ],
      );
      assert.notEqual(gates[0].run, gates[2].run);
    },
    { gate: true },
  );
});

test("a gate failure that is not a capacity wait writes its exit 1, not 75", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const { gates, results } = await gateRuns(fx, defaultDeps());
      assert.equal(results[0].ok, false);
      assert.equal(results[0].retry, undefined);
      assert.deepEqual(
        gates.map((g) => g.exit ?? g.event),
        ["gate.start", 1],
      );
    },
    {
      gate: true,
      execRuns: true,
      services:
        'services:\n  lib: { type: cli, repo: app, path: packages/lib, test: "false" }\nrepos:\n  app: { services: [lib], lint: "true", path_mappings: { packages/lib: lib } }\n',
    },
  );
});
