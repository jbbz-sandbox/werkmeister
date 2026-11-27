// SW-775: the metrics event log, and queue.wait / queue.admit at admission; SW-776: ask / answer from the hooks; SW-777: stage.done. Every line is checked against the schema.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { record } from "../dist/agent_state.js";
import { sandboxHome } from "../dist/config.js";
import { createLogger, machineLogPath, withLogger } from "../dist/logger.js";
import {
  gateRowKind,
  metricsPath,
  noteSlow,
  recordEvent,
  recordStageDone,
  recordTimed,
  runTag,
  stageDoneTimes,
  timed,
  workspaceLogSlice,
  workspaceSlice,
  workTypeOf,
} from "../dist/metrics.js";
import { defaultDeps, gatePrs, openPrs, refreshPrStatus } from "../dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { requestAdmission } from "../dist/scheduler_state.js";
import { stageDirs, templateFor } from "../dist/strategies/icm_templates.js";
import { initWorkspace, writeWorkspaceConfig } from "../dist/workspace_init.js";
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
function lines(when = new Date().toISOString()) {
  const file = metricsPath(when);
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

/** A workspace folder whose run id is `run-<name>`, so each writer's line is checked for it (SW-1161). */
function workspace(fx, name) {
  const ws = path.join(fx.root, "ws", name);
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), `run_id: run-${name}\n`);
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
          reason: "waiting for capacity",
          run_id: "run-mine",
        },
      );
      assert.equal(admit.event, "queue.admit");
      assert.equal(admit.feature, "mine");
      assert.equal(admit.run_id, "run-mine");
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
          return [o.event, o.at, o.workspace, o.pr, o.run_id];
        });
      const ws = path.basename(fx.workspace);
      const pr = "https://github.com/o/app/pull/1";
      const { run_id } = runTag(fx.workspace);
      assert.ok(run_id, "init gave the run an id");
      assert.deepEqual(got, [
        ["pr.open", "2026-01-02T03:04:05.000Z", ws, pr, run_id],
        ["pr.merged", "2026-01-02T04:05:06.000Z", ws, pr, run_id],
      ]);
    },
    { gate: true, merged: true },
  );
});

// SW-1051: racing passes write each pr.* line and make each issue move once.
const RACE_TAG_SERVICES = `services:
  lib:
    type: cli
    repo: app
    path: packages/lib
    test: "true"
repos:
  app:
    services: [lib]
    path_mappings:
      packages/lib: lib
    ship: tag
    release_tag: "v*"
`;

/** Events of one kind in the temp-HOME log, after asserting the file is inside the fixture. */
function eventsOf(fx, name) {
  const file = metricsPath("2026-01");
  assert.ok(file.startsWith(fx.root), `${file} is outside the fixture`);
  return fs
    .readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === name);
}

const issueMoves = (fx) =>
  fs
    .readFileSync(fx.ghLog, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("issue close ")).length;

test("two concurrent pr status passes write one pr.merged and one issue close (SW-1051)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      await Promise.all([refreshPrStatus(fx.workspace), refreshPrStatus(fx.workspace)]);
      assert.equal(eventsOf(fx, "pr.merged").length, 1);
      assert.equal(issueMoves(fx), 1, fs.readFileSync(fx.ghLog, "utf8"));
    },
    { gate: true, merged: true, issue: "o/app#1" },
  );
});

test("two concurrent pr status passes write one release line (SW-1051)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      const base = defaultDeps();
      const deps = {
        ...base,
        run: async (cmd, args, cwd) => {
          if (cmd === "git" && args.includes("--contains"))
            return { code: 0, stdout: "v1.0.0\n", stderr: "" };
          if (cmd === "git" && args.includes("for-each-ref"))
            return { code: 0, stdout: "2026-01-03T00:00:00Z\n", stderr: "" };
          return base.run(cmd, args, cwd);
        },
      };
      await Promise.all([refreshPrStatus(fx.workspace, deps), refreshPrStatus(fx.workspace, deps)]);
      assert.equal(eventsOf(fx, "pr.merged").length, 1);
      assert.equal(eventsOf(fx, "release").length, 1);
    },
    { gate: true, merged: true, services: RACE_TAG_SERVICES },
  );
});

test("two concurrent pr open calls write one pr.open (SW-1051)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const both = await Promise.all([
        openPrs(fx.workspace, undefined, undefined, { wait: false }),
        openPrs(fx.workspace, undefined, undefined, { wait: false }),
      ]);
      assert.equal(eventsOf(fx, "pr.open").length, 1, JSON.stringify(both));
    },
    { gate: true, merged: true },
  );
});

test("a pass that cannot get the lock in 30 s reports busy and writes nothing; a stale lock is broken (SW-1051)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const lock = path.join(fx.workspace, ".werkmeister", "pr-status.lock");
      assert.ok(lock.startsWith(fx.root));
      fs.writeFileSync(lock, "");
      const deps = { ...defaultDeps(), sleep: async () => {} };
      const busy = await refreshPrStatus(fx.workspace, deps);
      assert.deepEqual(busy.lines, ["another PR status pass is running"]);
      assert.equal(busy.changed, false);
      const old = new Date(Date.now() - 16 * 60_000);
      fs.utimesSync(lock, old, old);
      const ran = await refreshPrStatus(fx.workspace, deps);
      assert.notDeepEqual(ran.lines, ["another PR status pass is running"]);
      assert.equal(fs.existsSync(lock), false);
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
  const gates = lines().filter((l) => l.event === "gate.start" || l.event === "gate.end");
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
      const { run_id } = runTag(fx.workspace);
      assert.ok(run_id, "init gave the run an id");
      assert.deepEqual([start.run_id, end.run_id], [run_id, run_id]);
      // SW-404: every row the gate checked is a gate.row of this run.
      const rows = lines().filter((l) => l.event === "gate.row");
      assert.ok(rows.length > 0, "gate rows recorded");
      for (const r of rows) {
        assert.equal(r.run, start.run);
        assert.ok(r.row && r.result === "ok" && r.duration_ms >= 0, JSON.stringify(r));
        // SW-1101: each row carries its kind.
        assert.equal(r.row_kind, gateRowKind(r.row), JSON.stringify(r));
      }
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
      // SW-404: a row the gate adds without running a check (low memory here) is still a timed gate.row.
      const memory = lines().filter((l) => l.event === "gate.row" && l.row === "memory");
      assert.deepEqual(
        memory.map((l) => [l.run, l.result]),
        [[gates[0].run, "error"]],
      );
    },
    { gate: true },
  );
});

test("in a two-worktree workspace each repo's first gate is retry 0 and its second retry 1 (SW-1001)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const { gates, results } = await gateRuns(fx, defaultDeps(), defaultDeps());
      for (const r of results) assert.equal(r.ok, true, r.lines.join("\n"));
      assert.deepEqual(
        gates.filter((g) => g.event === "gate.start").map((g) => g.retry),
        [0, 0, 1, 1],
      );
      for (const repo of ["app", "web"]) {
        const counter = path.join(fx.workspace, ".werkmeister", `gate-runs-${repo}`);
        assert.ok(counter.startsWith(fx.root), "counter outside the fixture");
        assert.equal(fs.readFileSync(counter, "utf8"), "2\n");
      }
    },
    {
      gate: true,
      repos: [
        { name: "app", change: "packages/lib/index.js" },
        { name: "web", change: "packages/site/index.js" },
      ],
      services:
        'services:\n  lib: { type: cli, repo: app, path: packages/lib, test: "true" }\n  site: { type: cli, repo: web, path: packages/site, test: "true" }\nrepos:\n  app: { services: [lib], path_mappings: { packages/lib: lib } }\n  web: { services: [site], path_mappings: { packages/site: site } }\n',
      running: ["demo-lib", "demo-site"],
      workspaceServices: ["lib", "site"],
    },
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

// SW-777: stage.done at the record commit that first fills a stage's output/.
const icmRun = (fx) => {
  const ws = fx.workspace;
  const git = (...a) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
      cwd: ws,
      encoding: "utf8",
    }).trim();
  const commit = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), body);
    git("add", "-A");
    git("commit", "-q", "-m", rel);
    return git("rev-parse", "HEAD");
  };
  return { ws, commit, stages: stageDirs(templateFor("feature")) };
};
const stageDone = () => lines().filter((e) => e.event === "stage.done");

test("a fixture ICM run gives each stage one stage.done, at the commit that first filled it", () =>
  withFixtureWorkspace(
    async (fx) => {
      const { ws, commit, stages } = icmRun(fx);
      for (const s of stages) commit(`stages/${s}/output/.gitkeep`, "");
      recordStageDone(ws);
      assert.deepEqual(stageDone(), [], ".gitkeep alone fills nothing");
      const filled = {};
      for (const s of stages) {
        filled[s] = commit(`stages/${s}/output/out.md`, s);
        recordStageDone(ws);
      }
      // An earlier stage edited after the last one is done, then more sweeps: no second event.
      commit(`stages/${stages[0]}/output/out.md`, "edited");
      recordStageDone(ws);
      recordStageDone(ws);
      const done = stageDone();
      assert.deepEqual(
        done.map((e) => [e.workspace, e.stage, e.commit]),
        stages.map((s) => [path.basename(ws), s, filled[s]]),
      );
      // The log is the fixture's temp HOME, never the real ~/.werkmeister.
      assert.ok(metricsPath(new Date().toISOString()).startsWith(fx.root));
    },
    { workspace: { context_strategy: "icm" } },
  ));

test("parallel tool calls' hooks write one stage.done between them", () =>
  withFixtureWorkspace(
    async (fx) => {
      const { ws, commit, stages } = icmRun(fx);
      const sha = commit(`stages/${stages[0]}/output/inventory.md`, "x");
      const entry = new URL("../dist/agent_state.js", import.meta.url).href;
      const input = JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: ws,
        session_id: "s",
      });
      // Claude Code fires one hook process per tool call, so a batch of calls races on the claim.
      const hook = () =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            `import { main } from "${entry}"; main();`,
          ]);
          let err = "";
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (code) => resolve([code, err]));
          c.stdin.end(input);
        });
      for (const [code, err] of await Promise.all([hook(), hook(), hook(), hook()]))
        assert.equal(code, 0, err);
      assert.deepEqual(
        stageDone().map((e) => [e.stage, e.commit]),
        [[stages[0], sha]],
      );
    },
    { workspace: { context_strategy: "icm" } },
  ));

// SW-1025: `metrics rebuild` logs stage.done without a claim file; the live sweep must not add a second.
test("recordStageDone skips a stage whose stage.done rebuild already logged, but not a later stage", () =>
  withFixtureWorkspace(
    async (fx) => {
      const { ws, commit, stages } = icmRun(fx);
      const sha = commit(`stages/${stages[0]}/output/out.md`, "x");
      const at = new Date().toISOString();
      recordEvent(
        { event: "stage.done", workspace: path.basename(ws), stage: stages[0], commit: sha },
        at,
      );
      recordStageDone(ws);
      assert.equal(stageDone().length, 1, "no second line for the rebuilt stage");
      const next = commit(`stages/${stages[1]}/output/out.md`, "y");
      recordStageDone(ws);
      assert.deepEqual(
        stageDone().map((e) => [e.stage, e.commit]),
        [
          [stages[0], sha],
          [stages[1], next],
        ],
      );
      assert.equal(fs.existsSync(path.join(ws, ".werkmeister", "stage-done", stages[1])), true);
    },
    { workspace: { context_strategy: "icm" } },
  ));

// SW-776: ask / answer from the agent-state hooks.
const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000);
const hookLines = () => lines(at(0).toISOString()); // the hooks fire at T0's month, not today's

/** A recordable workspace under the fixture and a `fire(event, extra, seconds)` that records into it. */
function hookWorkspace(fx, name) {
  const ws = workspace(fx, name);
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "workspace.yml"),
    `autonomous: false\nrun_id: run-${name}\n`,
  );
  return (event, extra = {}, s = 0) =>
    record({ hook_event_name: event, cwd: ws, session_id: "s1", ...extra }, at(s));
}

const strip = ({ v, at, run_id, ...rest }) => rest;
const ASK = { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?" }] } };

test("one AskUserQuestion round-trip writes one ask and one answer timed tool_use→tool_result", async () => {
  await withFixtureWorkspace(async (fx) => {
    const fire = hookWorkspace(fx, "mine");
    assert.ok(metricsPath(at(0).toISOString()).startsWith(fx.root));
    fire("UserPromptSubmit");
    fire("PreToolUse", ASK, 10);
    fire("PostToolUse", ASK, 75);
    fire("Stop", { last_assistant_message: "Done." }, 80);
    assert.deepEqual(hookLines().map(strip), [
      { event: "ask", workspace: "mine", session: "s1", kind: "question" },
      { event: "answer", workspace: "mine", session: "s1", waited_s: 65 },
    ]);
    assert.deepEqual(
      hookLines().map((l) => l.run_id),
      ["run-mine", "run-mine"],
    );
  });
});

test("ExitPlanMode answers at its own PostToolUse, a rejected plan too", async () => {
  await withFixtureWorkspace(async (fx) => {
    const fire = hookWorkspace(fx, "plan");
    const plan = { tool_name: "ExitPlanMode", tool_input: { plan: "x" } };
    fire("PreToolUse", plan, 0);
    fire("PostToolUse", plan, 7);
    fire("PreToolUse", plan, 10);
    fire("PostToolUseFailure", plan, 12);
    assert.deepEqual(
      hookLines().map((l) => [l.event, l.kind ?? l.waited_s]),
      [
        ["ask", "plan"],
        ["answer", 7],
        ["ask", "plan"],
        ["answer", 2],
      ],
    );
  });
});

test("a wrap-up ask is answered at the next prompt, not at its own PostToolUse or Stop", async () => {
  await withFixtureWorkspace(async (fx) => {
    const fire = hookWorkspace(fx, "wrap");
    const wrap = { tool_name: "mcp__ccd_turn__wrap_up", tool_input: { ask: "Approve?" } };
    fire("PreToolUse", wrap, 0);
    fire("PostToolUse", wrap, 1);
    fire("Stop", { last_assistant_message: "Recap." }, 2);
    fire("UserPromptSubmit", {}, 30);
    fire("UserPromptSubmit", {}, 40);
    assert.deepEqual(
      hookLines().map((l) => [l.event, l.kind ?? l.waited_s]),
      [
        ["ask", "wrap-up"],
        ["answer", 30],
      ],
    );
  });
});

// SW-1005: a Stop message ending in "?" replaced the wrap_up ask, so its answer was never written.
test("a wrap-up ask keeps its answer when the Stop message also asks", async () => {
  await withFixtureWorkspace(async (fx) => {
    const fire = hookWorkspace(fx, "wrap-q");
    const wrap = { tool_name: "mcp__ccd_turn__wrap_up", tool_input: { ask: "Approve?" } };
    fire("PreToolUse", wrap, 0);
    fire("PostToolUse", wrap, 1);
    fire("Stop", { last_assistant_message: "PR file is written. Ready to merge?" }, 2);
    fire("UserPromptSubmit", {}, 30);
    assert.deepEqual(
      hookLines().map((l) => [l.event, l.kind ?? l.waited_s]),
      [
        ["ask", "wrap-up"],
        ["answer", 30],
      ],
    );
  });
});

test("other hook events write nothing, the ask-deleting ones included", async () => {
  await withFixtureWorkspace(async (fx) => {
    const fire = hookWorkspace(fx, "quiet");
    const bash = { tool_name: "Bash", tool_input: { command: "ls" } };
    fire("SessionStart");
    fire("UserPromptSubmit");
    for (const s of [1, 2]) {
      fire("PreToolUse", bash, s);
      fire("PostToolUse", bash, s);
    }
    fire("PermissionRequest", bash, 3);
    fire("Stop", { last_assistant_message: "Which one do you want?" }, 4);
    fire("UserPromptSubmit", {}, 5);
    fire("PostToolUse", ASK, 6); // no ask open
    // An ask a later tool call cleared (`:328`) is not answered by that call.
    fire("PreToolUse", ASK, 7);
    fire("PreToolUse", bash, 8);
    fire("PostToolUse", ASK, 9);
    assert.deepEqual(
      hookLines().map((l) => l.event),
      ["session.start", "ask"],
    );
  });
});

test("a headless turn on an interactive session's id writes nothing", async () => {
  const was = process.env.CLAUDE_CODE_ENTRYPOINT;
  try {
    await withFixtureWorkspace(async (fx) => {
      const fire = hookWorkspace(fx, "fork");
      process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
      fire("SessionStart");
      process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
      fire("PreToolUse", ASK, 1);
      fire("PostToolUse", ASK, 2);
      fire("SessionEnd", {}, 3);
      assert.deepEqual(
        hookLines().map((l) => l.event),
        ["session.start"],
        "only the interactive session's own start",
      );
    });
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = was;
  }
});

// SW-1172: a session's start and end, once each; a compact or clear restart is not a new session.
test("session.start and session.stop once per session, again after a resume", async () => {
  await withFixtureWorkspace(async (fx) => {
    const fire = hookWorkspace(fx, "sess");
    fire("SessionStart", { source: "startup" }, 0);
    fire("SessionStart", { source: "compact" }, 5);
    fire("SessionEnd", {}, 10);
    fire("SessionEnd", {}, 11);
    fire("SessionStart", { source: "resume" }, 20);
    fire("SessionEnd", {}, 30);
    assert.deepEqual(
      hookLines().map((l) => [l.event, l.session, l.run_id]),
      [
        ["session.start", "s1", "run-sess"],
        ["session.stop", "s1", "run-sess"],
        ["session.start", "s1", "run-sess"],
        ["session.stop", "s1", "run-sess"],
      ],
    );
  });
});

// SW-1172: the first status pass that sees a head's checks all finished logs ci.result; once per head.
test("pr status logs one ci.result per PR head once its checks finish", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      const run = (conclusion, completedAt) => ({
        __typename: "CheckRun",
        name: "test",
        conclusion,
        startedAt: "2026-01-03T10:00:00Z",
        ...(completedAt && { completedAt }),
      });
      let view;
      const base = defaultDeps();
      const deps = {
        ...base,
        run: async (cmd, args, cwd) => {
          const r = await base.run(cmd, args, cwd);
          if (cmd !== "gh" || args[1] !== "view" || r.code !== 0) return r;
          return { ...r, stdout: JSON.stringify({ ...JSON.parse(r.stdout), ...view }) };
        },
      };
      const status = { __typename: "StatusContext", context: "lint", state: "SUCCESS" };
      const pass = async (v) => {
        view = v;
        await refreshPrStatus(fx.workspace, deps);
      };
      await pass({ headRefOid: "a1", statusCheckRollup: [run("", null), status] });
      await pass({
        headRefOid: "a1",
        statusCheckRollup: [run("SUCCESS", "2026-01-03T10:09:00Z"), status],
      });
      await pass({
        headRefOid: "a1",
        statusCheckRollup: [run("SUCCESS", "2026-01-03T10:09:00Z"), status],
      });
      await pass({
        headRefOid: "b2",
        statusCheckRollup: [
          run("FAILURE", "2026-01-03T10:05:00Z"),
          { ...status, state: "PENDING" },
        ],
      });
      await pass({
        headRefOid: "b2",
        statusCheckRollup: [run("FAILURE", "2026-01-03T10:05:00Z"), { ...status, state: "ERROR" }],
      });
      const { run_id } = runTag(fx.workspace);
      assert.deepEqual(
        eventsOf(fx, "ci.result").map((e) => {
          assert.ok(validate(e), JSON.stringify(validate.errors));
          return [e.at, e.commit, e.result, e.duration_ms, e.pr, e.run_id];
        }),
        [
          [
            "2026-01-03T10:09:00.000Z",
            "a1",
            "ok",
            540000,
            "https://github.com/o/app/pull/1",
            run_id,
          ],
          [
            "2026-01-03T10:05:00.000Z",
            "b2",
            "error",
            300000,
            "https://github.com/o/app/pull/1",
            run_id,
          ],
        ],
      );
    },
    { gate: true },
  );
});

// SW-991: a waiting.json that enqueue() or requeueFirst() wrote left no line, so its writer was unknown.
test("every writer that queues a feature writes a queue.wait naming it", async () => {
  const { enqueue, requeueFirst } = await import("../dist/scheduler_state.js");
  await withFixtureWorkspace(async (fx) => {
    await enqueue("victim", workspace(fx, "victim"));
    await requeueFirst("head", workspace(fx, "head"));
    assert.deepEqual(
      lines().map(({ event, workspace, feature, position, reason, run_id }) => ({
        event,
        workspace,
        feature,
        position,
        reason,
        run_id,
      })),
      [
        {
          event: "queue.wait",
          workspace: "victim",
          feature: "victim",
          position: 1,
          reason: "preempted",
          run_id: "run-victim",
        },
        {
          event: "queue.wait",
          workspace: "head",
          feature: "head",
          position: 1,
          reason: "requeued",
          run_id: "run-head",
        },
      ],
    );
  });
});

// SW-1104: close-out pushes this slice; a reused name's earlier run (a commit not in HEAD) stays out.
test("workspaceSlice keeps this run's lines verbatim, oldest month first", async () => {
  await withFixtureWorkspace(async (fx) => {
    const ws = path.join(fx.root, "ws-s");
    fs.mkdirSync(ws);
    const g = (...a) =>
      execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        encoding: "utf8",
      }).trim();
    g("init", "-q");
    g("commit", "-q", "--allow-empty", "-m", "x");
    const head = g("rev-parse", "HEAD");
    const old = "0".repeat(40);
    recordEvent({ event: "pr.merged", workspace: "ws-s", pr: "u" }, "2026-12-01T00:00:00.000Z");
    recordEvent(
      { event: "stage.done", workspace: "ws-s", stage: "01_r", commit: head },
      "2026-11-02T00:00:00.000Z",
    );
    recordEvent(
      { event: "stage.done", workspace: "ws-s", stage: "02_s", commit: old },
      "2026-11-03T00:00:00.000Z",
    );
    recordEvent({ event: "pr.merged", workspace: "other", pr: "u" }, "2026-11-04T00:00:00.000Z");
    const slice = workspaceSlice(ws);
    assert.deepEqual(
      slice.map((l) => JSON.parse(l).at),
      ["2026-11-02T00:00:00.000Z", "2026-12-01T00:00:00.000Z"],
    );
    const nov = fs.readFileSync(metricsPath("2026-11-02T00:00:00.000Z"), "utf8").split("\n");
    assert.equal(slice[0], nov[0], "copied verbatim");
    assert.deepEqual([...stageDoneTimes(ws)], [["01_r", "2026-11-02T00:00:00.000Z"]]);
  });
});

// SW-1116: a reused name's earlier run logged lines under this name before this run's record branch
// had its first commit; only stage.done was checked against history, so the rest leaked in.
test("workspaceSlice drops a reused name's lines from before the record branch's first commit (SW-1116)", async () => {
  await withFixtureWorkspace(async (fx) => {
    const run = (cwd, date, ...a) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...(date && { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }) },
      }).trim();
    const main = path.join(fx.root, "main");
    fs.mkdirSync(main);
    run(main, null, "init", "-q", "-b", "main");
    run(main, "2026-10-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "scaffold");
    const ws = path.join(fx.root, "ws-r");
    run(fx.root, null, "clone", "-q", main, ws);
    run(ws, null, "checkout", "-q", "-b", "me/ws-r");
    run(ws, "2026-11-05T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "init");
    // A later rebase or amend moves the committer time, not the author time: the run still starts 11-05.
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--amend",
        "--no-edit",
        "--allow-empty",
      ],
      { cwd: ws, env: { ...process.env, GIT_COMMITTER_DATE: "2026-11-20T00:00:00Z" } },
    );
    const head = run(ws, null, "rev-parse", "HEAD");
    const issue = (ticket, at) =>
      recordEvent({ event: "issue.start", workspace: "ws-r", ticket }, at);
    issue("SW-1", "2026-11-01T00:00:00.000Z"); // the earlier run: no stage.done commit to check
    issue("SW-2", "2026-11-05T00:00:01.000Z");
    recordEvent(
      { event: "stage.done", workspace: "ws-r", stage: "01_r", commit: head },
      "2026-11-05T00:00:00.000Z",
    );
    assert.deepEqual(
      workspaceSlice(ws).map((l) => JSON.parse(l).ticket ?? JSON.parse(l).stage),
      ["SW-2", "01_r"],
    );
  });
});

// SW-1140: two runs of one name (a teammate's, or a reused name's late pr.merged) both log lines
// newer than either run's first commit; the run id in workspace.yml keeps each slice to its own.
test("workspaceSlice keeps two same-named runs' overlapping lines apart by run id (SW-1140)", async () => {
  await withFixtureWorkspace(async (fx) => {
    const run = (cwd, date, ...a) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...(date && { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }) },
      }).trim();
    const main = path.join(fx.root, "main");
    fs.mkdirSync(main);
    run(main, null, "init", "-q", "-b", "main");
    run(main, "2026-10-01T00:00:00Z", "commit", "-q", "--allow-empty", "-m", "scaffold");
    const clone = (who, id, date) => {
      const ws = path.join(fx.root, who, "ws-t");
      fs.mkdirSync(path.dirname(ws));
      run(fx.root, null, "clone", "-q", main, ws);
      run(ws, null, "checkout", "-q", "-b", `${who}/ws-t`);
      fs.mkdirSync(path.join(ws, ".werkmeister"));
      fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), `run_id: ${id}\n`);
      run(ws, date, "commit", "-q", "--allow-empty", "-m", "init");
      return ws;
    };
    const a = clone("amy", "run-a", "2026-11-05T00:00:00Z");
    const b = clone("bo", "run-b", "2026-11-06T00:00:00Z");
    const log = (ticket, run_id, at) =>
      recordEvent({ event: "issue.start", workspace: "ws-t", ticket, run_id }, at);
    log("SW-A", "run-a", "2026-11-07T00:00:00.000Z");
    log("SW-B", "run-b", "2026-11-08T00:00:00.000Z");
    recordEvent(
      { event: "pr.merged", workspace: "ws-t", pr: "a", run_id: "run-a" },
      "2026-11-09T00:00:00.000Z",
    );
    const tags = (ws) => workspaceSlice(ws).map((l) => JSON.parse(l).run_id);
    assert.deepEqual(tags(a), ["run-a", "run-a"]);
    assert.deepEqual(tags(b), ["run-b"]);
  });
});

// SW-1140: workspace.yml gets a run id once, a rerun keeps it, events carry it; a workspace with none
// (made before SW-1140) never wrote a tagged line, so a tagged line of its name is another run's.
test("init makes a run id once, migrate none; stage.done carries it (SW-1140)", async () => {
  await withFixtureWorkspace(async (fx) => {
    const ws = path.join(fx.root, "ws-i");
    const g = (...a) =>
      execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        encoding: "utf8",
      }).trim();
    fs.mkdirSync(path.join(ws, "stages", "01_r", "output"), { recursive: true });
    const write = (inputs, opts) =>
      withReporter(collectingReporter(), async () => writeWorkspaceConfig(ws, inputs, opts));
    // migrate's call (another workspace's file) makes none; only init's does.
    await write({ model: "opus" });
    assert.deepEqual(runTag(ws), {}, "a write without runId adds no id");
    await write({ feature: "f" }, { runId: true });
    const id = YAML.parse(
      fs.readFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "utf8"),
    ).run_id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    await write({ feature: "g" }, { runId: true });
    assert.deepEqual(runTag(ws), { run_id: id }, "a rerun keeps the id");
    await write({ model: "sonnet" });
    assert.deepEqual(runTag(ws), { run_id: id }, "a later migrate-style write keeps it too");

    g("init", "-q");
    fs.writeFileSync(path.join(ws, "stages", "01_r", "output", "a.md"), "x");
    g("add", ".");
    g("commit", "-q", "-m", "x");
    recordStageDone(ws);
    const done = lines().filter((l) => l.event === "stage.done");
    assert.deepEqual(
      done.map((l) => l.run_id),
      [id],
    );
    assert.equal(workspaceSlice(ws).length, 1);

    fs.rmSync(path.join(ws, ".werkmeister", "workspace.yml"));
    assert.deepEqual(runTag(ws), {});
    assert.deepEqual(workspaceSlice(ws), [], "no id of its own: the tagged line is another run's");
    assert.deepEqual(runTag(""), {}, "no path reads no cwd workspace.yml");
  });
});

test("schema: a coverage row needs no workspace; every other event still does (SW-405)", () => {
  const coverage = {
    v: 1,
    at: "2026-11-24T10:00:00Z",
    event: "coverage",
    source: "ci-main",
    commit: "d7b749c0",
    package: "werkmeister-core",
    lines: 54.8,
    branches: 52.82,
    functions: 34.15,
    statements: 54.8,
  };
  assert.ok(validate(coverage), JSON.stringify(validate.errors));
  assert.ok(validate({ ...coverage, workspace: "ws", source: "gate", run: "g1", tests: 3 }));
  assert.equal(validate({ ...coverage, lines: undefined }), false, "a metric is required");
  assert.equal(validate({ ...coverage, source: "local" }), false);
  assert.equal(validate({ ...coverage, lines: 100.5 }), false);
  assert.equal(
    validate({ v: 1, at: "2026-11-24T10:00:00Z", event: "gate.start", run: "g1", retry: 0 }),
    false,
    "gate.start without a workspace",
  );
});

test("a gate logs a coverage row per report its test rows wrote, with the gate's run id (SW-405)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const base = defaultDeps();
      const lib = path.join(fx.workspace, "app", "packages", "lib");
      const c = { total: 4, covered: 3, skipped: 0, pct: 75 };
      const run = async (bin, args, ...rest) => {
        const r = await base.run(bin, args, ...rest);
        // What a `test:coverage` row leaves behind in the worktree.
        if (bin === "docker" && args[0] === "exec") {
          fs.mkdirSync(path.join(lib, "coverage"), { recursive: true });
          fs.writeFileSync(
            path.join(lib, "coverage", "coverage-summary.json"),
            JSON.stringify({ total: { lines: c, branches: c, functions: c, statements: c } }),
          );
        }
        return r;
      };
      const { results } = await gateRuns(fx, { ...base, run });
      assert.equal(results[0].ok, true, results[0].lines.join("\n"));
      const start = lines().find((l) => l.event === "gate.start");
      const rows = lines().filter((l) => l.event === "coverage");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, "gate");
      assert.equal(rows[0].run, start.run);
      assert.equal(rows[0].workspace, path.basename(fx.workspace));
      assert.equal(rows[0].lines, 75);
    },
    { gate: true },
  );
});

// SW-404: workspace verbs, gate rows and slow calls are timed into this log; the machine log is sliced for close-out.
test("timed records workspace.* with duration_ms, result and the run id, and rethrows", async () => {
  await withFixtureWorkspace(async (fx) => {
    const ws = workspace(fx, "ws-timed");
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "run_id: run-t\n");
    assert.equal(await timed("workspace.up", ws, async () => 7), 7);
    await assert.rejects(
      timed("workspace.down", ws, async () => {
        throw new Error("no");
      }),
      /no/,
    );
    const mine = lines().filter((e) => e.workspace === "ws-timed");
    assert.deepEqual(
      mine.map((e) => [e.event, e.result, e.run_id, typeof e.duration_ms]),
      [
        ["workspace.up", "ok", "run-t", "number"],
        ["workspace.down", "error", "run-t", "number"],
      ],
    );
  });
});

test("gate.row and call.slow lines pass the schema; call.slow needs a bound workspace", async () => {
  await withFixtureWorkspace(async (fx) => {
    recordEvent({
      event: "gate.row",
      workspace: "ws-g",
      run: "g1",
      row: "werkmeister-core",
      duration_ms: 1200,
      result: "error",
    });
    noteSlow("install", 6000, "ok");
    const bound = createLogger(
      { app: "cli", workspace: "ws-g", run_id: "run-g", pid: 1 },
      { workspaceDir: workspace(fx, "ws-g"), stderr: false },
    );
    await withLogger(bound, async () => {
      noteSlow("git fetch", 4999, "ok");
      noteSlow("docker build", 5000, "error");
    });
    assert.deepEqual(
      lines()
        .filter((e) => e.workspace === "ws-g")
        .map((e) => [e.event, e.row ?? e.cmd, e.result, e.run_id]),
      [
        ["gate.row", "werkmeister-core", "error", undefined],
        ["call.slow", "docker build", "error", "run-g"],
      ],
    );
    assert.equal(
      lines().filter((e) => e.event === "call.slow").length,
      1,
      "the unbound call wrote no event",
    );
  });
});

test("workspaceLogSlice keeps this run's machine-log lines: its run id, or its name when untagged, .1 first", async () => {
  await withFixtureWorkspace(async (fx) => {
    const ws = workspace(fx, "ws-s");
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "run_id: run-s\n");
    const file = machineLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (msg, extra) =>
      JSON.stringify({ time: "2026-11-24T00:00:00.000Z", msg, ...extra });
    fs.writeFileSync(
      file.replace(/\.jsonl$/, ".1.jsonl"),
      `${line("old", { workspace: "ws-s" })}\n`,
    );
    fs.writeFileSync(
      file,
      [
        line("mine", { workspace: "ws-s", run_id: "run-s" }),
        line("earlier run", { workspace: "ws-s", run_id: "run-x" }),
        line("other", { workspace: "ws-o" }),
        line("untagged", { workspace: "ws-s" }),
        "not json",
      ].join("\n"),
    );
    assert.deepEqual(
      workspaceLogSlice(ws).map((l) => JSON.parse(l).msg),
      ["old", "mine", "untagged"],
    );
  });
});

// SW-1101: row kinds, per-task test.run from turbo's run summary, and capacity waits kept out of test rows.
test("gateRowKind: setup, lint, test, release, else checks", () => {
  assert.deepEqual(
    [
      "containers",
      "memory",
      "registry",
      "start lib",
      "lint",
      "test lib",
      "tests",
      "release",
      "stages",
      "review",
      "revert",
    ].map(gateRowKind),
    [
      "setup",
      "setup",
      "setup",
      "setup",
      "lint",
      "test",
      "test",
      "release",
      "checks",
      "checks",
      "checks",
    ],
  );
});

test("gate.row with row_kind and wait_ms and test.run pass the schema; test.run needs cached", () => {
  const at = "2026-11-25T10:00:00Z";
  const row = {
    v: 1,
    at,
    event: "gate.row",
    workspace: "ws",
    run: "g1",
    row: "test lib",
    row_kind: "test",
    duration_ms: 1200,
    wait_ms: 300,
    result: "ok",
  };
  assert.ok(validate(row), JSON.stringify(validate.errors));
  assert.equal(validate({ ...row, row_kind: "docs" }), false, "row_kind is an enum");
  const task = {
    v: 1,
    at,
    event: "test.run",
    workspace: "ws",
    run: "g1",
    row: "test lib",
    package: "lib",
    task: "test:coverage",
    duration_ms: 900,
    result: "error",
    cached: false,
    tests: 12,
    failures: 2,
  };
  assert.ok(validate(task), JSON.stringify(validate.errors));
  const { cached: _, ...noCached } = task;
  assert.equal(validate(noCached), false, "test.run without cached");
});

/** A turbo 2.x run summary, the shape probed in SW-1101's research (turbo 2.10.6). */
const turboSummary = (start) => ({
  id: "x",
  version: "1",
  turboVersion: "2.10.6",
  tasks: [
    {
      taskId: "lib#build",
      task: "build",
      package: "lib",
      directory: "packages/lib",
      cache: { local: true, remote: false, status: "HIT", timeSaved: 2352 },
      execution: { startTime: start, endTime: start + 15, exitCode: 0 },
    },
    {
      taskId: "lib#test:coverage",
      task: "test:coverage",
      package: "lib",
      directory: "packages/lib",
      cache: { local: false, remote: false, status: "MISS", timeSaved: 0 },
      execution: { startTime: start + 15, endTime: start + 4015, exitCode: 1 },
    },
    {
      taskId: "//#test:coverage",
      task: "test:coverage",
      package: "//",
      directory: "",
      cache: { status: "MISS" },
      execution: { startTime: start + 4015, endTime: start + 4100, exitCode: 0 },
    },
  ],
});

test("a gate's test row writes one test.run per turbo task, with counts from run.json, and removes the summary", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const base = defaultDeps();
      const repo = path.join(fx.workspace, "app");
      const runs = path.join(repo, ".turbo", "runs");
      let summary;
      const run = async (bin, args, ...rest) => {
        const r = await base.run(bin, args, ...rest);
        if (bin === "docker" && args[0] === "exec") {
          assert.deepEqual(args.slice(1, 3), ["-e", "TURBO_RUN_SUMMARY=true"]);
          // What turbo and coverage-run.mjs leave in the worktree.
          fs.mkdirSync(runs, { recursive: true });
          summary = path.join(runs, "r1.json");
          fs.writeFileSync(summary, JSON.stringify(turboSummary(Date.now())));
          fs.mkdirSync(path.join(repo, "packages", "lib", "coverage"), { recursive: true });
          fs.writeFileSync(
            path.join(repo, "packages", "lib", "coverage", "run.json"),
            JSON.stringify({ tests: 12, failures: 2, duration_ms: 3900 }),
          );
        }
        return r;
      };
      const { results } = await gateRuns(fx, { ...base, run });
      assert.ok(summary, results[0].lines.join("\n"));
      const start = lines().find((l) => l.event === "gate.start");
      const tasks = lines().filter((l) => l.event === "test.run");
      assert.deepEqual(
        tasks.map((t) => [
          t.run,
          t.row,
          t.package,
          t.task,
          t.duration_ms,
          t.result,
          t.cached,
          t.tests,
          t.failures,
        ]),
        [
          [start.run, "test lib", "lib", "build", 15, "ok", true, undefined, undefined],
          [start.run, "test lib", "lib", "test:coverage", 4000, "error", false, 12, 2],
        ],
      );
      assert.equal(fs.existsSync(summary), false, "the summary is read once");
    },
    { gate: true },
  );
});

test("a start's capacity wait is its own setup row, not the next row's time", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const base = defaultDeps();
      let starts = 0;
      // Stands in for an admission that queued: the start returns only after the wait.
      const startService = async (...a) => {
        starts++;
        await new Promise((r) => setTimeout(r, 1500));
        return base.startService(...a);
      };
      const { results } = await gateRuns(fx, { ...base, startService });
      assert.ok(starts > 0, `no start ran:\n${results[0].lines.join("\n")}`);
      const rows = lines().filter((l) => l.event === "gate.row");
      const start = rows.filter((r) => r.row.startsWith("start "));
      assert.ok(start.length > 0, JSON.stringify(rows));
      for (const r of start) {
        assert.equal(r.row_kind, "setup");
        assert.ok(r.duration_ms >= 1500, JSON.stringify(r));
      }
      for (const r of rows.filter((x) => !x.row.startsWith("start ")))
        assert.ok(r.duration_ms < 1500, `the wait leaked into ${JSON.stringify(r)}`);
    },
    { gate: true },
  );
});

test("workspace.create and workspace.init carry the yml's work_type after the step (SW-1212)", async () => {
  await withFixtureWorkspace(async (fx) => {
    const ws = workspace(fx, "ws-wt");
    const yml = path.join(ws, ".werkmeister", "workspace.yml");
    fs.writeFileSync(yml, "run_id: run-wt\nwork_type: Bugfix\n");
    recordTimed("workspace.create", ws, Date.now(), "ok");
    // An init that rewrites the type logs the new one, though timed() reads run_id before the step.
    await timed("workspace.init", ws, async () =>
      fs.writeFileSync(yml, "run_id: run-wt\nwork_type: refactor\n"),
    );
    await timed("workspace.up", ws, async () => {});
    fs.writeFileSync(yml, "run_id: run-wt\n");
    await timed("workspace.init", ws, async () => {});
    const mine = lines().filter((e) => e.workspace === "ws-wt");
    assert.ok(
      metricsPath(new Date().toISOString()).startsWith(fx.root),
      "written under the temp HOME",
    );
    assert.deepEqual(
      mine.map((e) => [e.event, e.run_id, e.work_type]),
      [
        ["workspace.create", "run-wt", "bugfix"],
        ["workspace.init", "run-wt", "refactor"],
        ["workspace.up", "run-wt", undefined],
        ["workspace.init", "run-wt", undefined],
      ],
    );
    assert.equal(workTypeOf("work_type: [x]"), undefined);
    assert.equal(workTypeOf(":"), undefined);
  });
});
