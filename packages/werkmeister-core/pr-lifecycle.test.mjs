// The workspace PR lifecycle (docs/workspace-lifecycle.md). PR files, the gate's
// decisions, lifecycle state and close-out ordering are real; git, gh, docker,
// HTTP and the issue tracker are stubbed at the `deps` seam.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { heldWakes, readNotices } from "./dist/agent_state.js";
import { dotDir } from "./dist/config.js";
import { resolveIssueStatuses } from "./dist/issue_status.js";
import {
  abandonWorkspace,
  adoptPr,
  callbackFields,
  callbackMessage,
  claimCallbacks,
  closeOut,
  defaultDeps,
  deliverHeadless,
  failedRowExcerpt,
  failureExcerpt,
  formatGate,
  gatePrs,
  gateTests,
  lifecycleOf,
  mapTouched,
  newPr,
  openPrs,
  openTerminalSessions,
  prFileDir,
  readPrFiles,
  refreshPrStatus,
  releaseVscodeSessions,
  removalBlockers,
  runGate,
  waitForHostLoadNow,
  wakeMessage,
  watchPrs,
  writePrFields,
} from "./dist/pr_lifecycle.js";
import { syncRegistry } from "./dist/registry_sync.js";
import { withReporter } from "./dist/reporter.js";
import { removeWorkspace, WorkspaceError } from "./dist/sandbox.js";
import { TEMP_HOME_SCRIPT } from "./dist/temp_home.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

// The host-load wait tests need it to wait; a caller exporting it for a quick run would skip it (SW-425).
delete process.env.WERKMEISTER_NO_WAIT;

const PASS_BODY = "## Acceptance\n| criterion | result |\n|---|---|\n| works | PASS |\n";

function prFile({ status = "approved", body = PASS_BODY, extra = "" } = {}) {
  return `---\nrepo: o/app\nbranch: me/ws\nbase: main\nstatus: ${status}\n${extra}---\n# feat: the title\n\n${body}`;
}

/** A temp ICM workspace: stages 01_research (done), 02_implement (exercise.md), 03_propose. */
function icmWorkspace({
  files = { app: prFile() },
  exercise = "| smoke | PASS |\n",
  researchDone = true,
  postmortem = "Problems: none\n",
} = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-life-"));
  const out = (d) => path.join(ws, "stages", d, "output");
  for (const d of ["01_research", "02_implement", "03_propose"])
    fs.mkdirSync(out(d), { recursive: true });
  if (researchDone) fs.writeFileSync(path.join(out("01_research"), "decisions.md"), "x");
  if (exercise !== null) fs.writeFileSync(path.join(out("02_implement"), "exercise.md"), exercise);
  for (const [dir, text] of Object.entries(files))
    fs.writeFileSync(path.join(out("03_propose"), `pr-${dir}.md`), text);
  fs.mkdirSync(dotDir(ws), { recursive: true });
  fs.writeFileSync(
    path.join(dotDir(ws), "workspace.yml"),
    "feature: feat\nservices: api,lib\nissue_id: o/app#7\nwork_type: feature\n",
  );
  fs.writeFileSync(path.join(ws, ".env"), "FEATURE=feat\nSANDBOX_SLOT=1\n");
  if (postmortem !== null) fs.writeFileSync(path.join(ws, "postmortem.md"), postmortem);
  return ws;
}

/** Stub `run`: the first [pattern, result] whose pattern matches `bin args…` wins; records every call. */
function stubRun(table) {
  const calls = [];
  const raw = [];
  const run = async (bin, args) => {
    raw.push([bin, ...args].join(" "));
    const line = [bin, ...bare(args)].join(" ");
    calls.push(line);
    for (const [re, res] of table)
      if (re.test(line)) return { stdout: "", stderr: "", code: 0, ...res };
    // The origin the PR file's `repo: o/app` must match (SW-194).
    const origin = /remote get-url origin$/.test(line) ? "git@github.com:o/app.git\n" : "";
    return { stdout: origin, stderr: "", code: 0 };
  };
  return { run, calls, raw };
}

// SW-329 wraps each gate exec in the inline temp-HOME script; matchers read the bare `sh -c <cmd>`.
function bare(args) {
  const i = args.indexOf(TEMP_HOME_SCRIPT);
  return i < 0 ? args : [...args.slice(0, i - 2), ...args.slice(i + 3)];
}

const REGISTRY = {
  services: {
    api: { type: "api", port_offset: 2, health_endpoint: "/health", test: "npm test -w api" },
    lib: { type: "library", port_offset: 3 },
  },
  repos: {
    app: {
      services: ["api", "lib"],
      path_mappings: { "apps/api": "api", "packages/lib": "lib" },
      no_service_paths: ["docs", ".changeset/", "README.md"],
      ship: "tag",
      release_tag: "v*",
      release_check: "npx changeset status",
    },
  },
};

function deps(table, over = {}) {
  const r = stubRun([[/^docker ps/, { stdout: "feat-api\nfeat-lib\n" }], ...table]);
  const stopped = [];
  const started = [];
  return {
    calls: r.calls,
    raw: r.raw,
    stopped,
    started,
    run: r.run,
    httpStatus: async () => 200,
    services: REGISTRY.services,
    archetypes: {},
    repos: REGISTRY.repos,
    tracker: {
      fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
      updateIssue: async () => {},
    },
    statuses: resolveIssueStatuses({ issue_review_status: "Peer Review" }, "github"),
    commitRecord: async () => ({ ok: true, message: "record pushed" }),
    remove: async () => ({ output: "removed" }),
    terminals: async () => [],
    sourceOf: async () => "/src/app",
    session: async () => ({}),
    sessionBusy: async () => false,
    branchRegistry: () => null,
    syncRegistry: () => {
      throw new Error("unexpected registry sync");
    },
    runningServices: () => [],
    stop: async (ws) => {
      stopped.push(ws);
      return "containers stopped";
    },
    prWatch: () => ({
      kind: "launchd",
      installed: true,
      current: true,
      where: "/p",
      logFile: "/l",
    }),
    reapIdle: async () => ({ lines: [] }),
    startService: async (_ws, feature, service, composeName) => {
      started.push(`${feature}-${service}`);
      r.calls.push(`start ${feature}-${service} from ${composeName ?? "compose.yml"}`);
    },
    gateCompose: () => [],
    portHolders: async () => [],
    hostLoad: () => ({ load: [0.5, 0.5, 0.5], cores: 4 }),
    sleep: async () => {},
    ...over,
  };
}

const clean = (ws) => fs.rmSync(ws, { recursive: true, force: true });
// The baseline check reads ports.yaml for host ports; CI has no ~/.werkmeister.
const gate = (ws, d) => withSandboxHome(() => runGate(ws, readPrFiles(ws)[0], d));
const open = (ws, d) => withSandboxHome(() => openPrs(ws, undefined, d));
const failed = (g) => g.checks.filter((c) => !c.ok).map((c) => c.name);

test("PR file: title and body split, writePrFields keeps the body", () => {
  const ws = icmWorkspace();
  try {
    const [f] = readPrFiles(ws);
    assert.equal(f.dir, "app");
    assert.equal(f.title, "feat: the title");
    assert.equal(f.body, PASS_BODY);
    writePrFields(f, { status: "open", url: "https://x/pr/1" });
    const [again] = readPrFiles(ws);
    assert.equal(again.fm.status, "open");
    assert.equal(again.fm.url, "https://x/pr/1");
    assert.equal(again.body, PASS_BODY);
  } finally {
    clean(ws);
  }
});

test("prFileDir: propose, legacy ship, JIT notes, spike's last stage (SW-83)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-dir-"));
  try {
    assert.equal(prFileDir(ws), path.join(dotDir(ws), "notes"));
    fs.mkdirSync(path.join(ws, "stages"));
    fs.writeFileSync(path.join(ws, "stages", ".DS_Store"), "");
    assert.equal(prFileDir(ws), null, "no stage dir yet");
    fs.mkdirSync(path.join(ws, "stages", "01_questions"));
    fs.mkdirSync(path.join(ws, "stages", "02_findings"));
    assert.equal(prFileDir(ws), path.join(ws, "stages", "02_findings", "output"));
    fs.mkdirSync(path.join(ws, "stages", "04_ship"));
    assert.equal(prFileDir(ws), path.join(ws, "stages", "04_ship", "output"));
    fs.mkdirSync(path.join(ws, "stages", "04_propose"));
    assert.equal(prFileDir(ws), path.join(ws, "stages", "04_propose", "output"));
  } finally {
    clean(ws);
  }
});

test("lifecycleOf: every state", () => {
  const cases = [
    [{}, "working"],
    [{ a: prFile({ status: "draft" }) }, "working"],
    [{ a: prFile({ status: "approved" }) }, "ready"],
    [{ a: prFile({ status: "open" }), b: prFile({ status: "approved" }) }, "pr-open"],
    [{ a: prFile({ status: "merged" }), b: prFile({ status: "shipped" }) }, "merged"],
    [{ a: prFile({ status: "shipped" }), b: prFile({ status: "closed" }) }, "shipped"],
    [{ a: prFile({ status: "abandoned" }) }, "abandoned"],
  ];
  for (const [files, want] of cases) {
    const ws = icmWorkspace({ files });
    try {
      assert.equal(lifecycleOf(ws).state, want, JSON.stringify(Object.keys(files)));
    } finally {
      clean(ws);
    }
  }
  const ws = icmWorkspace();
  try {
    fs.writeFileSync(path.join(ws, "closeout.md"), "x");
    assert.equal(lifecycleOf(ws).state, "closed-out");
  } finally {
    clean(ws);
  }
});

test("mapTouched: longest prefix wins; an unmapped file touches every service", () => {
  const repo = { services: ["a", "b", "c"], path_mappings: { apps: "a", "apps/b": "b" } };
  assert.deepEqual(mapTouched(["apps/b/x.ts", "apps/z.ts"], repo), ["a", "b"]);
  assert.deepEqual(mapTouched(["README.md"], repo), ["a", "b", "c"]);
});

test("mapTouched: a path_mappings entry for a non-service path touches only its service (SW-450)", () => {
  const repo = { services: ["a", "b"], path_mappings: { "apps/a": "a", plugins: "b" } };
  assert.deepEqual(mapTouched(["plugins/x/SKILL.md"], repo), ["b"]);
});

test("mapTouched: no_service_paths touch nothing; other unmapped files still touch every service", () => {
  const repo = {
    services: ["a", "b"],
    path_mappings: { "apps/a": "a", "docs/a": "a" },
    no_service_paths: ["docs", ".changeset/", "README.md"],
  };
  assert.deepEqual(mapTouched(["docs/x.md", ".changeset/y.md", "README.md"], repo), []);
  assert.deepEqual(mapTouched(["docs/x.md", "apps/a/z.ts"], repo), ["a"]);
  assert.deepEqual(mapTouched(["docs/a/x.md"], repo), ["a"], "a longer path_mappings prefix wins");
  assert.deepEqual(mapTouched(["docs/x.md", "package.json"], repo), ["a", "b"]);
  assert.deepEqual(
    mapTouched(["README.mdx"], repo),
    ["a", "b"],
    "a file prefix matches only that file",
  );
});

const DIFF_API = [
  /git -C \S+ diff --name-only origin\/main\.\.\.HEAD/,
  { stdout: "apps/api/x.ts\n" },
];

// SW-478: check-in approves a PR by flipping the file with its note; the gate must read that as approved.
test("gate passes on a PR file approved via check-in, the note a YAML comment", async () => {
  const status = "approved  # approved via check-in 2026-11-06";
  const ws = icmWorkspace({ files: { app: prFile({ status }) } });
  try {
    const g = await gate(ws, deps([DIFF_API]));
    assert.deepEqual(failed(g), []);
    assert.equal(readPrFiles(ws)[0].fm.status, "approved");
  } finally {
    clean(ws);
  }
});

test("gate passes: tests, exercise, baseline, release check, approved", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.ok(d.calls.includes("docker exec feat-api sh -c npm test -w api"));
    assert.ok(d.calls.includes("docker exec feat-api sh -c npx changeset status"));
  } finally {
    clean(ws);
  }
});

// SW-316: `pr gate --tests` during implement: no PR file, uncommitted code, lint and test rows only.
function implementWorkspace(files = {}) {
  const ws = icmWorkspace({ files, exercise: null, researchDone: false });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  return ws;
}
const MERGE_BASE = [/merge-base origin\/main HEAD$/, { stdout: "abc\n" }];
const gateT = (ws, d, only) => withSandboxHome(() => gateTests(ws, only, d));

test("gate --tests: no PR file, an uncommitted api change runs only the api test row", async () => {
  const ws = implementWorkspace();
  try {
    const d = deps([MERGE_BASE, [/diff --name-only abc$/, { stdout: "apps/api/x.ts\n" }]]);
    const g = await gateT(ws, d);
    assert.equal(g.ok, true, g.lines.join("\n"));
    assert.deepEqual(
      g.lines.filter((l) => /^ {2}[✓✗]/.test(l)).map((l) => l.split(":")[0].trim()),
      ["✓ tests", "✓ containers", "✓ test api"],
    );
    assert.ok(d.calls.includes("docker exec feat-api sh -c npm test -w api"));
    assert.ok(!d.calls.some((c) => c.includes("...HEAD") || c.includes("changeset status")));
  } finally {
    clean(ws);
  }
});

test("gate --tests: an untracked file maps to its service", async () => {
  const ws = implementWorkspace();
  try {
    const d = deps([MERGE_BASE, [/ls-files --others/, { stdout: "apps/api/new.ts\n" }]]);
    const g = await gateT(ws, d);
    assert.ok(d.calls.includes("docker exec feat-api sh -c npm test -w api"), g.lines.join("\n"));
  } finally {
    clean(ws);
  }
});

test("gate --tests: a test that fails only in the container fails the run (SW-294's shape)", async () => {
  const ws = implementWorkspace();
  try {
    const d = deps([
      MERGE_BASE,
      [/diff --name-only abc$/, { stdout: "apps/api/x.ts\n" }],
      [/docker exec feat-api sh -c npm test/, { code: 1, stdout: "not ok 1 - 401\n" }],
    ]);
    const g = await gateT(ws, d);
    assert.equal(g.ok, false);
    assert.ok(
      g.lines.some((l) => l.includes("✗ test api")),
      g.lines.join("\n"),
    );
  } finally {
    clean(ws);
  }
});

test("gate --tests: a PR file's base applies", async () => {
  const pr = "---\nrepo: o/app\nbranch: me/ws\nbase: dev\nstatus: draft\n---\n# t\n";
  const ws = implementWorkspace({ app: pr });
  try {
    const d = deps([
      [/merge-base origin\/dev HEAD$/, { stdout: "abc\n" }],
      [/diff --name-only abc$/, { stdout: "apps/api/x.ts\n" }],
    ]);
    const g = await gateT(ws, d);
    assert.ok(d.calls.includes("docker exec feat-api sh -c npm test -w api"), g.lines.join("\n"));
  } finally {
    clean(ws);
  }
});

test("gate --tests: an unknown worktree name throws naming the worktrees", async () => {
  const ws = implementWorkspace();
  try {
    await assert.rejects(
      gateT(ws, deps([]), "nope"),
      /No code worktree named nope; worktrees: app/,
    );
  } finally {
    clean(ws);
  }
});

test("gate: a docs-only diff runs no service tests and passes without skip_tests; the release check still runs", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([[/diff --name-only/, { stdout: "docs/a.md\n.changeset/b.md\nREADME.md\n" }]]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.deepEqual(
      g.checks.filter((c) => /^(test|baseline) /.test(c.name)),
      [],
    );
    assert.ok(d.calls.includes("docker exec feat-api sh -c npx changeset status"));
  } finally {
    clean(ws);
  }
});

test("gate: docs plus code tests only the code's service", async () => {
  const ws = icmWorkspace();
  try {
    const g = await gate(
      ws,
      deps([[/diff --name-only/, { stdout: "docs/a.md\napps/api/x.ts\n" }]]),
    );
    assert.deepEqual(failed(g), []);
    assert.deepEqual(
      g.checks.filter((c) => c.name.startsWith("test ")).map((c) => c.name),
      ["test api"],
    );
    // SW-450: the service the diff left out is named, not silently dropped.
    assert.deepEqual(
      g.checks.filter((c) => c.name === "tests").map((c) => [c.ok, c.detail]),
      [[true, "not touched, not run: lib"]],
    );
  } finally {
    clean(ws);
  }
});

test("gate: an unmapped non-doc file still touches every service", async () => {
  const ws = icmWorkspace();
  try {
    const g = await gate(ws, deps([[/diff --name-only/, { stdout: "docs/a.md\npackage.json\n" }]]));
    assert.deepEqual(
      g.checks.filter((c) => c.name.startsWith("test ")).map((c) => c.name),
      ["test api", "test lib"],
    );
    assert.deepEqual(failed(g), ["test lib"]);
    // SW-563: the row says which file made every service run, so it gets mapped, not started again.
    assert.deepEqual(
      g.checks.filter((c) => c.name === "tests").map((c) => [c.ok, c.detail]),
      [[true, "every service: no path_mappings or no_service_paths entry for package.json"]],
    );
  } finally {
    clean(ws);
  }
});

test("gate: a start that failed, then succeeded as the gate's on-demand start, does not fail the gate (SW-552)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([], {
      services: {
        ...REGISTRY.services,
        lib: { ...REGISTRY.services.lib, test: "npm test -w lib" },
      },
    });
    // No container of the repo is running, so the gate must start lib itself.
    const r = stubRun([
      [/^docker ps/, { stdout: "" }],
      [/diff --name-only/, { stdout: "packages/lib/x.ts\n" }],
    ]);
    d.run = r.run;
    d.calls = r.calls;
    let starts = 0;
    d.startService = async (_ws, feature, service) => {
      d.started.push(`${feature}-${service}`);
      if (++starts === 1) throw new Error("No capacity to start lib for 'feat' after 10 min");
    };
    const g = await gate(ws, d);
    assert.deepEqual(d.started, ["feat-lib", "feat-lib"]);
    assert.deepEqual(failed(g), []);
    assert.match(
      g.checks.find((c) => c.name === "start lib").detail,
      /second attempt.*No capacity/,
    );
    assert.ok(d.calls.includes("docker exec feat-lib sh -c npm test -w lib"));
  } finally {
    clean(ws);
  }
});

test("gate: changed files that map to no service fail a tests row unless skip_tests.tests gives a reason (SW-278)", async () => {
  const diff = [/diff --name-only/, { stdout: "src/x.ts\n" }];
  const noRepo = { repos: {} }; // no `repos:` entry for the worktree
  const ws = icmWorkspace();
  try {
    const g = await gate(ws, deps([diff], noRepo));
    assert.deepEqual(failed(g), ["tests"]);
    assert.match(g.checks.find((c) => c.name === "tests").detail, /no service maps to src\/x\.ts/);
    // An empty diff still passes with no tests row.
    const empty = await gate(ws, deps([[/diff --name-only/, { stdout: "" }]], noRepo));
    assert.deepEqual(failed(empty), []);
    assert.ok(!empty.checks.some((c) => c.name === "tests"));
  } finally {
    clean(ws);
  }
  const skipped = icmWorkspace({
    files: { app: prFile({ extra: "skip_tests:\n  tests: scripts only, ran by hand\n" }) },
  });
  try {
    const g = await gate(skipped, deps([diff], noRepo));
    assert.deepEqual(failed(g), []);
    assert.match(g.checks.find((c) => c.name === "tests").detail, /skipped: scripts only/);
  } finally {
    clean(skipped);
  }
});

test("gate fails on an unfinished stage, a FAIL row and an unapproved file, before the tests (SW-150)", async () => {
  const ws = icmWorkspace({
    researchDone: false,
    files: { app: prFile({ status: "draft", body: "| x | FAIL |\n" }) },
  });
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["stages", "acceptance", "approved", "tests"]);
    assert.ok(!d.calls.some((c) => c.startsWith("docker exec")));
  } finally {
    clean(ws);
  }
});

test("gate: repo: that is not the worktree's origin fails naming repo:, expected and actual, before the tests (SW-194)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile().replace("repo: o/app", "repo: JayAndCory/sandbox") },
  });
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["repo", "tests"]);
    const detail = g.checks.find((c) => c.name === "repo").detail;
    assert.match(detail, /repo: is JayAndCory\/sandbox/);
    assert.match(detail, /origin is o\/app/);
    assert.ok(!d.calls.some((c) => c.startsWith("docker exec")));
  } finally {
    clean(ws);
  }
});

test("gate: repo: matches an SSH, HTTPS or .git-less origin (SW-194)", async () => {
  for (const url of [
    "git@github.com:o/app.git",
    "https://github.com/o/app.git",
    "https://github.com/O/app/",
  ]) {
    const ws = icmWorkspace();
    try {
      const g = await gate(
        ws,
        deps([[/remote get-url origin$/, { stdout: `${url}\n` }], DIFF_API]),
      );
      assert.deepEqual(failed(g), [], url);
    } finally {
      clean(ws);
    }
  }
});

// SW-457: a grouped PR's gate warns, never fails, when the base won't rebase-merge; SW-462: a queue decides.
test("gate: a grouped workspace's merge row reads the base's rules and warns unless rebase is possible (SW-457)", async () => {
  const rules = (r) => [/^gh api repos\/o\/app\/rules\/branches\/main$/, r];
  const json = (x) => ({ stdout: JSON.stringify(x) });
  const pr = (methods) => ({
    type: "pull_request",
    parameters: { allowed_merge_methods: methods },
  });
  const queue = (m) => ({ type: "merge_queue", parameters: { merge_method: m } });
  const cases = [
    [
      json([pr(["squash"])]),
      /^warning: main's ruleset allows squash only; a grouped PR needs rebase/,
    ],
    [json([pr(["squash", "rebase"])]), /^rebase allowed on main$/],
    [
      json([pr(["squash", "rebase"]), queue("SQUASH")]),
      /^warning: main's merge queue merges with SQUASH; .*bypass the queue/,
    ],
    // The queue decides: a squash-only PR rule does not matter when every PR goes through it.
    [json([pr(["squash"]), queue("REBASE")]), /^rebase allowed on main \(merge queue\)$/],
    // Org and repo rulesets each add a rule; any one without rebase blocks it.
    [
      json([pr(["merge", "squash", "rebase"]), pr(["squash"])]),
      /^warning: main's ruleset allows squash only/,
    ],
    [json([]), /^rebase allowed on main$/],
    [{ code: 1, stderr: "HTTP 403\n" }, /^warning: could not read main's rules — HTTP 403$/],
  ];
  for (const [res, want] of cases) {
    const ws = icmWorkspace();
    fs.appendFileSync(path.join(dotDir(ws), "workspace.yml"), "group:\n  - SW-2\n");
    try {
      const g = await gate(ws, deps([rules(res), DIFF_API]));
      assert.deepEqual(failed(g), [], String(want));
      assert.match(g.checks.find((c) => c.name === "merge").detail, want);
    } finally {
      clean(ws);
    }
  }
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.ok(!g.checks.some((c) => c.name === "merge"), "no merge row without group");
    assert.ok(!d.calls.some((c) => c.startsWith("gh api")));
  } finally {
    clean(ws);
  }
});

/** Exercise evidence missing from a stage that has other output, so the stages check passes. */
function noExercise(opts = {}) {
  const ws = icmWorkspace({ exercise: null, ...opts });
  fs.writeFileSync(path.join(ws, "stages", "02_implement", "output", "fix.md"), "x");
  return ws;
}

test("gate fails on missing exercise evidence", async () => {
  const ws = noExercise();
  try {
    assert.deepEqual(failed(await gate(ws, deps([DIFF_API]))), ["exercise", "tests"]);
  } finally {
    clean(ws);
  }
});

test("gate: a malformed exercise.md fails before any test command runs (SW-286)", async () => {
  const table = (cell) => `| check | result |\n|---|---|\n| x | ${cell} |\n`;
  for (const cell of ["PASS: ok", "(reproduces bug)"]) {
    const ws = icmWorkspace({ exercise: table(cell) });
    try {
      const d = deps([DIFF_API]);
      const g = await gate(ws, d);
      assert.deepEqual(failed(g), ["exercise", "tests"], cell);
      assert.match(g.checks.find((c) => c.name === "tests").detail, /^not run/);
      assert.ok(!d.calls.some((c) => c.startsWith("docker exec")), d.calls.join("\n"));
    } finally {
      clean(ws);
    }
  }
});

test("gate: a FAIL row in the PR file's Tests table is named with its heading (SW-390)", async () => {
  const body =
    `${PASS_BODY}\n## Tests\n| test | result | output |\n|---|---|---|\n` +
    "| x.test.ts before the fix | FAIL | AssertionError |\n";
  const ws = icmWorkspace({ files: { app: prFile({ body }) } });
  try {
    const g = await gate(ws, deps([DIFF_API]));
    assert.deepEqual(failed(g), ["acceptance", "tests"]);
    assert.match(
      g.checks.find((c) => c.name === "acceptance").detail,
      /^PR file has a FAIL row under "## Tests": \| x\.test\.ts before the fix \| FAIL \|/,
    );
  } finally {
    clean(ws);
  }
});

test("gate: an exercise result cell of `FAIL — why`, or neither PASS nor FAIL, fails the exercise check (SW-247)", async () => {
  const table = (cell) => `| check | result |\n|---|---|\n| smoke | PASS |\n| x | ${cell} |\n`;
  for (const [cell, detail] of [
    ["FAIL — why", /has a FAIL row/],
    ["skipped, no container", /neither PASS nor FAIL/],
  ]) {
    const ws = icmWorkspace({ exercise: table(cell) });
    try {
      const g = await gate(ws, deps([DIFF_API]));
      assert.deepEqual(failed(g), ["exercise", "tests"], cell);
      assert.match(g.checks.find((c) => c.name === "exercise").detail, detail);
    } finally {
      clean(ws);
    }
  }
  const pass = icmWorkspace({ exercise: table("PASS") });
  try {
    assert.deepEqual(failed(await gate(pass, deps([DIFF_API]))), []);
  } finally {
    clean(pass);
  }
});

test("gate: a MANUAL acceptance row passes and is named; FAIL still blocks; exercise takes no MANUAL (SW-155)", async () => {
  const body = (cell) =>
    `| criterion | result | evidence |\n|---|---|---|\n| works | PASS | x |\n| set_monitor in desktop | ${cell} | needs a real PR |\n`;
  const manual = icmWorkspace({ files: { app: prFile({ body: body("MANUAL") }) } });
  try {
    const g = await gate(manual, deps([DIFF_API]));
    assert.deepEqual(failed(g), []);
    assert.equal(
      g.checks.find((c) => c.name === "acceptance").detail,
      "all PASS; MANUAL, for the reviewer: set_monitor in desktop",
    );
  } finally {
    clean(manual);
  }
  const withFail = icmWorkspace({
    files: { app: prFile({ body: `${body("MANUAL")}| other | FAIL | y |\n` }) },
  });
  try {
    assert.deepEqual(failed(await gate(withFail, deps([DIFF_API]))), ["acceptance", "tests"]);
  } finally {
    clean(withFail);
  }
  const exercise = icmWorkspace({ exercise: "| check | result |\n|---|---|\n| x | MANUAL |\n" });
  try {
    const g = await gate(exercise, deps([DIFF_API]));
    assert.deepEqual(failed(g), ["exercise", "tests"]);
    assert.match(g.checks.find((c) => c.name === "exercise").detail, /neither PASS nor FAIL/);
  } finally {
    clean(exercise);
  }
});

test("gate: a decided follow-up with no issue key fails, naming it; a key or a proposed status passes (SW-490)", async () => {
  const withDecisions = (text) => {
    const ws = icmWorkspace();
    fs.writeFileSync(path.join(ws, "stages", "01_research", "output", "decisions.md"), text);
    return ws;
  };
  const q = (status, answer) => `## 11. Codex resume\nstatus: ${status}\n\n${answer}\n`;
  const unnamed = withDecisions(
    `# d\n\n${q("decided", "Out of scope; filed as a follow-up after approval.")}`,
  );
  try {
    const g = await gate(unnamed, deps([DIFF_API]));
    assert.deepEqual(failed(g), ["follow-ups", "tests"], "fails before any test command");
    assert.match(
      g.checks.find((c) => c.name === "follow-ups").detail,
      /no issue key: 01_research: ## 11\. Codex resume — file it/,
    );
  } finally {
    clean(unnamed);
  }
  for (const text of [
    q("decided", "Out of scope; filed as a follow-up: SW-512."),
    q("decided", "Deferred to a follow-up, https://github.com/o/app/issues/12."),
    q("proposed", "Defer to a follow-up."),
    q("decided", "No follow-up needed: the snapshot file is regenerated."),
    q("decided", "The PR file covers it; the follow-up PR comes from pr new."),
  ]) {
    const ws = withDecisions(text);
    try {
      assert.deepEqual(failed(await gate(ws, deps([DIFF_API]))), [], text);
    } finally {
      clean(ws);
    }
  }
});

/** An ICM workspace inited with the SW-388 review step; *review* is its review.md, null for none. */
function reviewWorkspace(review, opts = {}) {
  const ws = icmWorkspace(opts);
  const stage = path.join(ws, "stages", "02_implement");
  fs.writeFileSync(path.join(stage, "CONTEXT.md"), "Write `output/review.md`: …\n");
  if (review !== null) fs.writeFileSync(path.join(stage, "output", "review.md"), review);
  return ws;
}

test("gate: the review check (SW-388)", async (t) => {
  const review = (cell) => `| check | result | evidence |\n|---|---|---|\n| app | ${cell} | ok |\n`;
  const cases = [
    [
      "missing review.md fails before the tests",
      reviewWorkspace(null),
      ["review", "tests"],
      /no review\.md/,
    ],
    [
      "all PASS passes",
      reviewWorkspace(review("PASS")),
      [],
      /02_implement\/output\/review\.md all PASS$/,
    ],
    ["a FAIL row fails", reviewWorkspace(review("FAIL")), ["review", "tests"], /has a FAIL row/],
    [
      "skip_review skips it",
      reviewWorkspace(null, { files: { app: prFile({ extra: "skip_review: docs only\n" }) } }),
      [],
      /^skipped: docs only$/,
    ],
  ];
  for (const [name, ws, fails, detail] of cases)
    await t.test(name, async () => {
      try {
        const g = await gate(ws, deps([DIFF_API]));
        assert.deepEqual(failed(g), fails);
        assert.match(g.checks.find((c) => c.name === "review").detail, detail);
      } finally {
        clean(ws);
      }
    });
  await t.test("a workspace inited before SW-388 has no review check", async () => {
    const ws = icmWorkspace();
    try {
      const g = await gate(ws, deps([DIFF_API]));
      assert.ok(!g.checks.some((c) => c.name === "review"));
    } finally {
      clean(ws);
    }
  });
});

test("gate: a malformed acceptance row fails before any test command runs, naming the cell format (SW-150)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ body: "| works | PASS: repro.md section 1 |\n" }) },
  });
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["acceptance", "tests"]);
    assert.match(g.checks.find((c) => c.name === "acceptance").detail, /exactly `PASS` or `FAIL`/);
    assert.deepEqual(
      d.calls.filter((c) => /^(docker exec|start )/.test(c)),
      [],
    );
  } finally {
    clean(ws);
  }
});

test("gate: a touched service with no test command fails unless skip_tests gives a reason", async () => {
  const diffLib = [/diff --name-only/, { stdout: "packages/lib/y.ts\n" }];
  const ws = icmWorkspace();
  try {
    assert.deepEqual(failed(await gate(ws, deps([diffLib]))), ["test lib"]);
  } finally {
    clean(ws);
  }
  const skipped = icmWorkspace({
    files: { app: prFile({ extra: "skip_tests:\n  lib: pure types, covered by api tests\n" }) },
  });
  try {
    const g = await gate(skipped, deps([diffLib]));
    assert.deepEqual(failed(g), []);
    assert.match(g.checks.find((c) => c.name === "test lib").detail, /skipped: pure types/);
  } finally {
    clean(skipped);
  }
});

test("gate: a service whose registry says test: none is skipped with its reason, no skip_tests needed (SW-119)", async () => {
  const diffLib = [/diff --name-only/, { stdout: "packages/lib/y.ts\n" }];
  const ws = icmWorkspace();
  try {
    const services = {
      ...REGISTRY.services,
      lib: { type: "library", test: "none: no test script" },
    };
    const d = deps([diffLib], { services });
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.equal(
      g.checks.find((c) => c.name === "test lib").detail,
      "skipped: registry says no tests: no test script",
    );
    assert.ok(!d.calls.some((c) => /docker exec .*none/.test(c)), "never runs `none`");
  } finally {
    clean(ws);
  }
});

test("gate: a failing release check fails unless skip_release gives a reason", async () => {
  const noChangeset = [/changeset status/, { code: 1, stderr: "no changesets were found" }];
  const ws = icmWorkspace();
  try {
    assert.deepEqual(failed(await gate(ws, deps([DIFF_API, noChangeset]))), ["release"]);
  } finally {
    clean(ws);
  }
  const skipped = icmWorkspace({ files: { app: prFile({ extra: "skip_release: docs only\n" }) } });
  try {
    assert.deepEqual(failed(await gate(skipped, deps([DIFF_API, noChangeset]))), []);
  } finally {
    clean(skipped);
  }
});

const WITH_LINT = {
  repos: { app: { ...REGISTRY.repos.app, lint: "pnpm exec biome ci ." } },
};

test("gate: a repo's lint command runs and passes with its row (SW-133)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API], WITH_LINT);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.ok(d.calls.includes("docker exec feat-api sh -c pnpm exec biome ci ."));
    assert.equal(
      formatGate("app", g).find((l) => l.includes("lint:")),
      "  ✓ lint: pnpm exec biome ci . → exit 0",
    );
  } finally {
    clean(ws);
  }
});

test("gate: a failing lint fails the gate and blocks pr open (SW-133)", async () => {
  const lintError = [/biome ci/, { code: 1, stderr: "packages/x.ts format ━━━━\nFound 1 error." }];
  const ws = icmWorkspace();
  try {
    const g = await gate(ws, deps([DIFF_API, lintError], WITH_LINT));
    assert.deepEqual(failed(g), ["lint"]);
    assert.match(g.checks.find((c) => c.name === "lint").detail, /exit 1\n.*\nFound 1 error\./);
    const d = deps([DIFF_API, lintError], WITH_LINT);
    const r = await open(ws, d);
    assert.equal(r.ok, false);
    assert.ok(!d.calls.some((c) => c.startsWith("gh pr create")));
  } finally {
    clean(ws);
  }
});

test("failedRowExcerpt: failing test lines above the tail, then the tail; no match is the tail alone (SW-317)", () => {
  const out = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  out[4] = "not ok 3 - parses x";
  out[9] = "✖ y throws";
  out[35] = "FAIL in the tail";
  const tail = out.slice(-15);
  assert.equal(
    failedRowExcerpt(`${out.join("\n")}\n`, 15),
    ["not ok 3 - parses x", "✖ y throws", ...tail].join("\n"),
  );
  const plain = Array.from({ length: 40 }, (_, i) => `ok ${i}`).join("\n");
  assert.equal(failedRowExcerpt(plain, 15), plain.split("\n").slice(-15).join("\n"));
});

test("gate: a failing test row names the failing test from early in its output and saves the full log (SW-317)", async () => {
  const out = [
    "TAP version 13",
    "not ok 2 - api rejects a bad token",
    ...Array.from({ length: 30 }, (_, i) => `# noise ${i}`),
    " ELIFECYCLE  Test failed.",
  ].join("\n");
  const ws = icmWorkspace();
  try {
    const g = await gate(ws, deps([DIFF_API, [/npm test -w api/, { code: 1, stdout: out }]]));
    assert.ok(failed(g).includes("test api"));
    const log = path.join(dotDir(ws), "gate-app-test-api.log");
    const detail = g.checks.find((c) => c.name === "test api").detail;
    assert.match(detail, /exit 1\nnot ok 2 - api rejects a bad token\n/);
    assert.ok(detail.includes(`full log: ${log}`));
    assert.equal(fs.readFileSync(log, "utf8"), out);
  } finally {
    clean(ws);
  }
});

test("gate: a repo without lint has no lint row and runs no lint (SW-133)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.ok(!g.checks.some((c) => c.name === "lint"));
    assert.ok(!d.calls.some((c) => c.includes("biome")));
  } finally {
    clean(ws);
  }
});

test("gate: a port the start would publish is held, so it fails before starting or testing (SW-173)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ extra: "skip_release: changeset committed, checked on host\n" }) },
  });
  fs.writeFileSync(
    path.join(dotDir(ws), "workspace.yml"),
    "feature: feat\nservices: backend,frontend\nissue_id: o/app#7\nwork_type: feature\n",
  );
  const d = deps([]);
  d.run = stubRun([[/^docker ps/, { stdout: "" }], DIFF_API]).run;
  d.portHolders = async (_ws, _feature, services) =>
    services.map(() => ({ port: 11102, holder: "other-werkmeister-core" }));
  try {
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["ports", "tests"]);
    assert.match(
      g.checks.find((c) => c.name === "ports").detail,
      /11102 held by other-werkmeister-core/,
    );
    assert.deepEqual(d.started, []);
    assert.ok(!d.calls.some((c) => /test|vitest|node --test/.test(c) && !c.startsWith("git")));
  } finally {
    clean(ws);
  }
});

test("gate: a touched service with a test command but no container fails unless skip_tests gives a reason", async () => {
  // #145: the workspace runs other services (k8s), so this repo has no container,
  // and here the gate cannot start one either (SW-34).
  const noContainers = (ws) => {
    fs.writeFileSync(
      path.join(dotDir(ws), "workspace.yml"),
      "feature: feat\nservices: backend,frontend\nissue_id: o/app#7\nwork_type: feature\n",
    );
    const d = deps([]);
    d.run = stubRun([[/^docker ps/, { stdout: "" }], DIFF_API]).run;
    d.startService = async (_ws, _feature, service) => {
      d.started.push(service);
      throw new Error("compose up failed");
    };
    return d;
  };
  const ws = icmWorkspace({
    files: { app: prFile({ extra: "skip_release: changeset committed, checked on host\n" }) },
  });
  try {
    const g = await gate(ws, noContainers(ws));
    assert.deepEqual(failed(g), ["start api", "test api"]);
    assert.match(
      g.checks.find((c) => c.name === "test api").detail,
      /no running container for this repo/,
    );
  } finally {
    clean(ws);
  }
  const skipped = icmWorkspace({
    files: {
      app: prFile({
        extra:
          "skip_release: changeset committed, checked on host\nskip_tests:\n  api: ran on host, 12/12 pass\n",
      }),
    },
  });
  try {
    const d = noContainers(skipped);
    const g = await gate(skipped, d);
    assert.deepEqual(failed(g), []);
    assert.match(g.checks.find((c) => c.name === "test api").detail, /skipped: ran on host/);
    assert.deepEqual(d.started, [], "nothing needs a container, so none is started");
  } finally {
    clean(skipped);
  }
});

/** No container of the repo runs; the workspace lists no services (SW-34). */
function noServices(ws, table = []) {
  fs.writeFileSync(
    path.join(dotDir(ws), "workspace.yml"),
    "feature: feat\nservices: \nissue_id: o/app#7\nwork_type: feature\n",
  );
  const d = deps([]);
  const r = stubRun([[/^docker ps/, { stdout: "" }], ...table, DIFF_API]);
  d.run = r.run;
  d.calls = r.calls;
  return d;
}

test("gate starts the touched service's container for a repo with none, tests through it, then stops it (SW-34, SW-336)", async () => {
  const ws = icmWorkspace();
  try {
    const d = noServices(ws);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.deepEqual(
      d.started,
      ["feat-api"],
      "api's own container; it also serves the release check",
    );
    assert.ok(d.calls.includes("docker exec feat-api sh -c npm test -w api"), d.calls.join("\n"));
    assert.ok(d.calls.includes("docker exec feat-api sh -c npx changeset status"));
    assert.equal(d.calls.at(-1), "docker stop feat-api");
    assert.match(g.checks.find((c) => c.name === "containers").detail, /started feat-api/);
  } finally {
    clean(ws);
  }
});

test("gate: a touched web service's test runs in its own container, started on demand, not a sibling's (SW-336)", async () => {
  const services = {
    ...REGISTRY.services,
    web: { type: "web", port_offset: 4, test: "pnpm --filter web build", setup_service: "install" },
  };
  const app = REGISTRY.repos.app;
  const repos = {
    app: {
      ...app,
      services: [...app.services, "web"],
      path_mappings: { ...app.path_mappings, "apps/web": "web" },
    },
  };
  const diffWeb = [/diff --name-only/, { stdout: "apps/web/x.ts\n" }];
  const ws = icmWorkspace();
  try {
    // Nothing running: the gate must start web itself (compose brings up its setup service).
    const none = noServices(ws, [diffWeb]);
    Object.assign(none, { services, repos });
    const g = await gate(ws, none);
    assert.ok(none.started.includes("feat-web"), `started: ${none.started}`);
    assert.ok(
      none.calls.includes("docker exec feat-web sh -c pnpm --filter web build"),
      none.calls.join("\n"),
    );
    assert.deepEqual(failed(g), []);

    // A sibling (api) already runs: web still gets its own container, not api's.
    const sib = deps([diffWeb], { services, repos });
    const r = stubRun([[/^docker ps/, { stdout: "feat-api\n" }], diffWeb]);
    Object.assign(sib, { run: r.run, calls: r.calls });
    await gate(ws, sib);
    assert.ok(
      !r.calls.includes("docker exec feat-api sh -c pnpm --filter web build"),
      r.calls.join("\n"),
    );
    assert.ok(sib.started.includes("feat-web"), `started: ${sib.started}`);
  } finally {
    clean(ws);
  }
});

test("gate stops the container it started when a test fails (SW-34)", async () => {
  const ws = icmWorkspace();
  try {
    const d = noServices(ws, [[/npm test -w api/, { code: 1, stdout: "1 failing" }]]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["test api"]);
    assert.equal(d.calls.at(-1), "docker stop feat-api");
  } finally {
    clean(ws);
  }
});

test("gate: a docs-only diff starts a container only for the release check (SW-34)", async () => {
  const ws = icmWorkspace();
  try {
    const d = noServices(ws, [[/diff --name-only/, { stdout: "docs/a.md\n" }]]);
    assert.deepEqual(failed(await gate(ws, d)), []);
    assert.deepEqual(d.started, ["feat-lib"]);
  } finally {
    clean(ws);
  }
  const skipped = icmWorkspace({ files: { app: prFile({ extra: "skip_release: docs only\n" }) } });
  try {
    const d = noServices(skipped, [[/diff --name-only/, { stdout: "docs/a.md\n" }]]);
    assert.deepEqual(failed(await gate(skipped, d)), []);
    assert.deepEqual(d.started, []);
    assert.ok(!d.calls.some((c) => c.startsWith("docker stop")));
  } finally {
    clean(skipped);
  }
});

test("gate: stops nothing when the repo's containers already run; one `up` re-runs their setup (SW-34, SW-362)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    // `up` of the running service leaves it as is and re-runs the exited one-shot; once per gate.
    assert.deepEqual(d.started, ["feat-api"]);
    assert.ok(!d.calls.some((c) => c.startsWith("docker stop")));
    // Only the kept row (SW-355), never a started-and-stopped one.
    assert.deepEqual(
      g.checks.filter((c) => c.name === "containers").map((c) => c.detail),
      ["kept (feat-api already running, setup one-shot re-run unless current)"],
    );
  } finally {
    clean(ws);
  }
});

test("gate starts a service compose.yml defines when the branch registry renamed it (SW-87)", async () => {
  // The branch renames lib → lib-renamed; compose.yml is rendered from the machine
  // registry, which still says lib.
  const branch = {
    services: {
      api: REGISTRY.services.api,
      "lib-renamed": { type: "library", test: "npm test -w lib" },
    },
    repos: {
      app: {
        ...REGISTRY.repos.app,
        services: ["api", "lib-renamed"],
        path_mappings: { "apps/api": "api", "packages/lib": "lib-renamed" },
      },
    },
  };
  const ws = icmWorkspace();
  try {
    const d = noServices(ws, [[/diff --name-only/, { stdout: "packages/lib/y.ts\n" }]]);
    d.branchRegistry = () => branch;
    d.startService = async (_ws, feature, service) => {
      if (!REGISTRY.repos.app.services.includes(service))
        throw new Error(`no such service: ${service}`);
      d.started.push(`${feature}-${service}`);
    };
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.deepEqual(d.started, ["feat-lib"]);
    assert.ok(d.calls.includes("docker exec feat-lib sh -c npm test -w lib"), d.calls.join("\n"));
    assert.match(
      g.checks.find((c) => c.name === "registry").detail,
      /names lib-renamed as lib .*werkmeister registry/,
    );
    assert.ok(d.calls.includes("docker exec feat-lib sh -c npx changeset status"));

    // A container already running under the compose id serves the branch id.
    const running = deps([], { branchRegistry: () => branch });
    const r = stubRun([
      [/^docker ps/, { stdout: "feat-lib\n" }],
      [/diff --name-only/, { stdout: "packages/lib/y.ts\n" }],
    ]);
    Object.assign(running, { run: r.run, calls: r.calls });
    assert.deepEqual(failed(await gate(ws, running)), []);
    // Kept, not started: the one `up` re-runs its setup one-shot under the compose id (SW-362).
    assert.deepEqual(running.started, ["feat-lib"]);
    assert.ok(running.calls.includes("docker exec feat-lib sh -c npm test -w lib"));
  } finally {
    clean(ws);
  }
});

test("gate: baseline checks only touched local api/web services (SW-34)", async () => {
  const ws = icmWorkspace();
  const diffLib = [/diff --name-only/, { stdout: "packages/lib/y.ts\n" }];
  const baselines = (g) =>
    g.checks.filter((c) => c.name.startsWith("baseline ")).map((c) => c.name);
  try {
    assert.deepEqual(baselines(await gate(ws, deps([diffLib]))), []);
    assert.deepEqual(baselines(await gate(ws, deps([DIFF_API]))), ["baseline api"]);
    const libOnly = deps([]);
    libOnly.run = stubRun([[/^docker ps/, { stdout: "feat-lib\n" }], DIFF_API]).run;
    libOnly.startService = async () => {
      throw new Error("compose up failed");
    };
    const g = await gate(ws, libOnly);
    // A running sibling does not serve api's test, and api's own container never came up.
    assert.deepEqual(failed(g), ["start api", "test api", "baseline api"]);
  } finally {
    clean(ws);
  }
});

test("gate: runs the branch's own test commands, not the shared registry's (SW-25)", async () => {
  const ws = icmWorkspace();
  try {
    const seen = [];
    const renamed = { ...REGISTRY.services.api, test: "npm test -w api-renamed" };
    const d = deps([DIFF_API], {
      branchRegistry: (repo, worktree) => {
        seen.push([repo, worktree]);
        return { services: { ...REGISTRY.services, api: renamed }, repos: REGISTRY.repos };
      },
    });
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.deepEqual(seen, [["app", path.join(ws, "app")]]);
    assert.ok(d.calls.includes("docker exec feat-api sh -c npm test -w api-renamed"));
    assert.ok(!d.calls.includes("docker exec feat-api sh -c npm test -w api"));
  } finally {
    clean(ws);
  }
});

test("gate: a touched service whose branch settings change compose runs from compose.gate.yml, then compose.yml again (SW-118)", async () => {
  // compose.yml, and so feat-api, comes from the machine registry; the branch adds REDIS_URL.
  const ws = icmWorkspace();
  try {
    const api = { ...REGISTRY.services.api, environment: { REDIS_URL: "redis://redis:6379" } };
    const rendered = [];
    const d = deps([DIFF_API], {
      branchRegistry: () => ({ services: { ...REGISTRY.services, api }, repos: REGISTRY.repos }),
      gateCompose: (_ws, _feature, services) => {
        rendered.push(services.api.environment);
        return ["api", "lib"];
      },
    });
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.deepEqual(rendered, [{ REDIS_URL: "redis://redis:6379" }]);
    const order = d.calls.filter((c) => /^start |^docker exec feat-api sh -c npm/.test(c));
    assert.deepEqual(order, [
      "start feat-api from compose.gate.yml",
      "docker exec feat-api sh -c npm test -w api",
      "start feat-api from compose.yml",
    ]);
    assert.match(
      g.checks.find((c) => c.name === "containers").detail,
      /recreated api from the branch's container settings for the gate, then from compose\.yml again/,
    );

    // Not running before: started from the branch's settings, then stopped (SW-34).
    const cold = deps([], { branchRegistry: d.branchRegistry, gateCompose: () => ["api"] });
    const r = stubRun([[/^docker ps/, { stdout: "feat-lib\n" }], DIFF_API]);
    Object.assign(cold, { run: r.run, calls: r.calls });
    assert.deepEqual(failed(await gate(ws, cold)), []);
    assert.deepEqual(cold.started, ["feat-api"]);
    assert.ok(cold.calls.includes("docker stop feat-api"), cold.calls.join("\n"));
  } finally {
    clean(ws);
  }
});

test("gate: a broken branch fragment fails the gate with its error, not a crash", async () => {
  const ws = icmWorkspace();
  try {
    const g = await gate(
      ws,
      deps([DIFF_API], {
        branchRegistry: () => {
          throw new Error("app/.werkmeister/services.yaml: services.api must be a map");
        },
      }),
    );
    assert.deepEqual(failed(g), ["registry"]);
    assert.match(g.checks.find((c) => c.name === "registry").detail, /services\.api must be a map/);
  } finally {
    clean(ws);
  }
});

test("gate: test, lint and release commands run through the temp-HOME wrapper in the container (SW-329)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    assert.deepEqual(failed(await gate(ws, d)), []);
    const execs = d.raw.filter((c) => c.startsWith("docker exec "));
    assert.ok(execs.length >= 2, d.raw.join("\n"));
    const wrapped = `sh -c ${TEMP_HOME_SCRIPT} with-temp-home --no-wait sh -c `;
    for (const c of execs) assert.ok(c.includes(wrapped), c);
    assert.ok(execs.includes(`docker exec feat-api ${wrapped}npm test -w api`));
  } finally {
    clean(ws);
  }
});

test("gate: failing test, down health endpoint", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API, [/npm test -w api/, { code: 1, stdout: "1 failing" }]], {
      httpStatus: async () => 502,
    });
    assert.deepEqual(failed(await gate(ws, d)), ["test api", "baseline api"]);
  } finally {
    clean(ws);
  }
});

test("gate: a dirty worktree stops before lint and tests start containers (SW-364)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API, [/status --porcelain/, { stdout: " M x.ts\n" }]]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["clean", "tests"]);
    assert.match(g.checks.find((c) => c.name === "clean").detail, /M x\.ts/);
    assert.deepEqual(
      d.calls.filter((c) => /^docker (ps|exec)/.test(c)),
      [],
    );
  } finally {
    clean(ws);
  }
});

const NO_PUSH = [
  /push --dry-run --no-verify origin me\/ws$/,
  { code: 128, stderr: "git@github.com: Permission denied (publickey).\n" },
];

test("gate: no push access fails in the quick rows, before lint and tests (SW-408)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API, NO_PUSH]);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), ["push", "tests"]);
    assert.match(g.checks.find((c) => c.name === "push").detail, /publickey.*ssh-add/);
    assert.deepEqual(
      d.calls.filter((c) => /^docker exec/.test(c)),
      [],
    );
  } finally {
    clean(ws);
  }
});

test("openPrs: no push access pushes and opens nothing (SW-408)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API, NO_PUSH]);
    const r = await open(ws, d);
    assert.equal(r.ok, false);
    assert.deepEqual(
      d.calls.filter((c) => /push -u origin|^gh pr create/.test(c)),
      [],
    );
  } finally {
    clean(ws);
  }
});

test("openPrs: refuses a failed gate, opens an approved one and records it", async () => {
  const ws = icmWorkspace();
  try {
    let updated = null;
    let recorded = null;
    const d = deps([DIFF_API, [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }]], {
      session: async () => ({ session: "s-1", host_session: "local_h1" }),
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "Open", labels: [] }),
        updateIssue: async (ref, u) => (updated = [ref, u.status, u.comment]),
      },
      commitRecord: async (_ws, _msg, paths) => {
        recorded = paths;
        return { ok: true, message: "record pushed" };
      },
    });
    const r = await open(ws, d);
    assert.ok(r.ok, r.lines.join("\n"));
    const [f] = readPrFiles(ws);
    assert.equal(f.fm.status, "open");
    assert.equal(f.fm.url, "https://github.com/o/app/pull/9");
    assert.equal(f.fm.session, "s-1", "the callback rides on the PR file (#236)");
    assert.equal(f.fm.host_session, "local_h1");
    assert.ok(
      !r.lines.some((l) => l.includes("<pr-created>")),
      "no desktop Auto-fix marker (SW-160)",
    );
    assert.ok(
      !Number.isNaN(Date.parse(f.fm.notified_review)),
      "review news starts at the open, so an early review still wakes (SW-160)",
    );
    assert.deepEqual(
      updated,
      ["o/app#7", "Peer Review", "PR opened: https://github.com/o/app/pull/9"],
      "the status comes from issue_review_status, the comment names the PR",
    );
    assert.deepEqual(
      recorded,
      [
        "stages/03_propose/output/pr-app.md",
        ".werkmeister/gate-app-release.log",
        ".werkmeister/gate-app-test-api.log",
      ],
      "the record commit names the PR file and the gate logs (SW-401)",
    );
    assert.ok(d.calls.some((c) => c.startsWith("git -C") && c.endsWith("push -u origin me/ws")));
    assert.deepEqual(d.stopped, [ws], "containers stop once the PR is open (SW-39)");
    assert.equal(r.lines.at(-1), "containers stopped");
    const passed = r.lines.indexOf("app: gate passed");
    assert.ok(passed >= 0, "a passing open prints the gate header (SW-198)");
    assert.match(r.lines[passed + 1], /^ {2}✓ /, "and each ✓ row");
    assert.ok(
      passed < r.lines.indexOf("app: open https://github.com/o/app/pull/9"),
      "before the PR URL",
    );
  } finally {
    clean(ws);
  }
  const bad = icmWorkspace({ exercise: "| smoke | FAIL |\n" });
  try {
    const d = deps([DIFF_API]);
    const r = await open(bad, d);
    assert.equal(r.ok, false);
    assert.ok(!d.calls.some((c) => c.startsWith("gh pr create")));
    assert.equal(readPrFiles(bad)[0].fm.status, "approved");
    assert.deepEqual(d.stopped, [], "a failed gate keeps the containers for the fix");
    assert.ok(r.lines.includes("app: gate FAILED"), "failing rows still print");
  } finally {
    clean(bad);
  }
});

test("openPrs: with no tracker injected, each workspace's project gets the in_review move (SW-104)", async () => {
  for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];
  const config = `jira: { base_url: https://x.atlassian.net, email: a@b.c, api_token: tok }
projects:
  acme: { tracker: { id: github, org: acme }, issue_statuses: { in_review: "status: review" } }
  werkmeister: { tracker: { id: jira, project: SW } }
`;
  const ghIssue = { title: "T", state: "OPEN", labels: [], assignees: [], comments: [] };
  const jiraCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    jiraCalls.push(`${init.method ?? "GET"} ${String(url).replace("https://x.atlassian.net", "")}`);
    if (init.method === "POST") return new Response(null, { status: 204 });
    if (String(url).includes("/transitions"))
      return Response.json({ transitions: [{ id: "31", to: { name: "In Review" } }] });
    return Response.json({
      key: "SW-9",
      fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
    });
  };
  const yml = (issue, project) =>
    `feature: feat\nservices: api,lib\nissue_id: ${issue}\nproject: ${project}\nwork_type: feature\n`;
  const ghWs = icmWorkspace();
  const jiraWs = icmWorkspace();
  fs.writeFileSync(path.join(dotDir(ghWs), "workspace.yml"), yml("acme/app#7", "acme"));
  fs.writeFileSync(path.join(dotDir(jiraWs), "workspace.yml"), yml("SW-9", "werkmeister"));
  const created = [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }];
  try {
    await withSandboxHome(
      () =>
        withFakeGh({ issue: ghIssue }, async (bin) => {
          const ghCalls = () =>
            fs
              .readFileSync(path.join(path.dirname(bin), "calls"), "utf8")
              .trim()
              .split("\n");
          const ghR = await openPrs(
            ghWs,
            undefined,
            deps([DIFF_API, created], { tracker: undefined, statuses: undefined }),
          );
          assert.ok(ghR.ok, ghR.lines.join("\n"));
          assert.ok(ghCalls().includes("issue edit 7 -R acme/app --add-label status: review"));
          assert.deepEqual(jiraCalls, [], "the GitHub workspace never calls Jira");

          const before = ghCalls().length;
          const jiraR = await openPrs(
            jiraWs,
            undefined,
            deps([DIFF_API, created], { tracker: undefined, statuses: undefined }),
          );
          assert.ok(jiraR.ok, jiraR.lines.join("\n"));
          assert.ok(
            jiraCalls.includes("POST /rest/api/2/issue/SW-9/transitions"),
            jiraCalls.join("\n"),
          );
          assert.equal(ghCalls().length, before, "the Jira workspace never calls gh");
        }),
      { config },
    );
  } finally {
    globalThis.fetch = realFetch;
    clean(ghWs);
    clean(jiraWs);
  }
});

test("openPrs: warns to use a merge commit when the branch adds a blame-ignore SHA", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([
      DIFF_API,
      [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }],
      [/diff origin\/main\.\.\.HEAD -- \.git-blame-ignore-revs/, { stdout: "+c69bc70abc\n" }],
    ]);
    const r = await open(ws, d);
    assert.ok(
      r.lines.some((l) => /warning: .*merge commit/.test(l)),
      r.lines.join("\n"),
    );
  } finally {
    clean(ws);
  }
});

test("openPrs: hold: opens a draft whose body starts with the hold line; without it, no change (SW-461)", async () => {
  for (const hold of ["apply the merge-queue ruleset", ""]) {
    const ws = icmWorkspace({ files: { app: prFile({ extra: hold ? `hold: ${hold}\n` : "" }) } });
    try {
      const d = deps([
        DIFF_API,
        [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }],
      ]);
      const run = d.run;
      let body;
      // The body file is removed right after gh pr create, so read it as the call is made.
      d.run = async (bin, args, cwd) => {
        if (bin === "gh" && args[1] === "create")
          body = fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
        return run(bin, args, cwd);
      };
      const r = await open(ws, d);
      assert.equal(r.ok, true, r.lines.join("\n"));
      const create = d.calls.find((c) => c.startsWith("gh pr create"));
      if (hold) {
        assert.match(create, / --draft$/);
        assert.ok(body.startsWith(`Don't merge until: ${hold}\n\n${PASS_BODY}`), body);
        assert.ok(
          r.lines.includes(
            `  hold: opened as a draft — run gh pr ready https://github.com/o/app/pull/9 once: ${hold}`,
          ),
          r.lines.join("\n"),
        );
      } else {
        assert.ok(!create.includes("--draft"), create);
        assert.equal(body, PASS_BODY);
        assert.ok(!r.lines.some((l) => l.includes("hold:")), r.lines.join("\n"));
      }
    } finally {
      clean(ws);
    }
  }
  // Already open: gh pr create isn't run, so the hold can't apply; say so instead of staying silent.
  const ws = icmWorkspace({ files: { app: prFile({ extra: "hold: x\n" }) } });
  try {
    const d = deps([DIFF_API, [/^gh pr list/, { stdout: "https://github.com/o/app/pull/9\n" }]]);
    const r = await open(ws, d);
    assert.ok(!d.calls.some((c) => c.startsWith("gh pr create")));
    assert.ok(
      r.lines.includes(
        "  hold: not applied, the PR was already open — run gh pr ready --undo https://github.com/o/app/pull/9 to make it a draft",
      ),
      r.lines.join("\n"),
    );
  } finally {
    clean(ws);
  }
});

test("openPrs: nothing approved is refused and stops nothing (SW-39)", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "draft" }) } });
  try {
    const d = deps([DIFF_API]);
    await assert.rejects(open(ws, d), (e) => {
      assert.match(e.message, /pr-app\.md is at status: draft; set status: approved to open it\./);
      assert.doesNotMatch(e.message, /No matching PR file/);
      return true;
    });
    assert.deepEqual(d.stopped, []);
  } finally {
    clean(ws);
  }
});

test("runGate: touches the idle reaper's exec marker before docker exec (SW-39)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    await gate(ws, d);
    assert.ok(
      d.calls.some((c) => c.startsWith("docker exec")),
      d.calls.join("\n"),
    );
    assert.ok(fs.existsSync(path.join(dotDir(ws), "last-exec")));
  } finally {
    clean(ws);
  }
});

/** A host whose 1-min load reads *loads* in turn (the last one repeats), on 4 cores: limit 8. */
function loaded(loads) {
  const slept = [];
  let i = 0;
  return {
    slept,
    hostLoad: () => {
      const l = loads[Math.min(i++, loads.length - 1)];
      return { load: [l, l, l], cores: 4 };
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
}
const testRow = (g) => g.checks.find((c) => c.name === "test api");

test("runGate: a failed test row ends with the host load (SW-209)", async () => {
  const ws = icmWorkspace();
  try {
    const host = loaded([90]);
    const timedOut = [
      /^docker exec .* npm test -w api/,
      { code: 1, stderr: "Test timed out in 60000ms" },
    ];
    const g = await gate(ws, deps([DIFF_API, timedOut], host));
    const row = testRow(g);
    assert.equal(row.ok, false);
    assert.match(row.detail, /Test timed out in 60000ms/);
    assert.match(
      row.detail.split("\n").at(-1),
      /^host load 90\.0 \/ 90\.0 \/ 90\.0 \(1, 5, 15 min\) on 4 cores$/,
    );
  } finally {
    clean(ws);
  }
});

test("runGate: a paused container fails as paused, with no exec and no test verdict (SW-391)", async () => {
  const ws = icmWorkspace();
  try {
    const paused = [/^docker inspect -f \{\{\.State\.Paused\}\} feat-api$/, { stdout: "true\n" }];
    const r = stubRun([
      [/^docker ps/, { stdout: "feat-api\tpaused\nfeat-lib\trunning\n" }],
      DIFF_API,
      paused,
    ]);
    const d = { ...deps([]), run: r.run, calls: r.calls };
    const g = await gate(ws, d);
    assert.equal(g.ok, false);
    assert.equal(testRow(g), undefined);
    assert.ok(!d.calls.some((c) => c.startsWith("docker exec")), d.calls.join("\n"));
    assert.ok(
      g.checks.some((c) => c.name === "containers" && !c.ok && /feat-api is paused/.test(c.detail)),
    );
    assert.ok(
      !g.checks.some((c) => c.name === "containers" && c.ok),
      "no ✓ for a paused container",
    );
    assert.deepEqual(d.started, [], "no setup one-shot re-run into a paused container");
  } finally {
    clean(ws);
  }
});

test("runGate: never waits on host load; admission prices its starts (SW-542)", async () => {
  const ws = icmWorkspace();
  try {
    // Over the limit before every row, as after the gate's own install and test rows.
    const host = loaded([90]);
    const d = deps([DIFF_API], host);
    const g = await gate(ws, d);
    assert.deepEqual(host.slept, []);
    assert.equal(testRow(g).ok, true);
    assert.doesNotMatch(testRow(g).detail, /waited .* for host load/);
  } finally {
    clean(ws);
  }
});

test("waitForHostLoadNow: with-temp-home's wait polls and says up front how long it may wait (SW-224, SW-262)", async () => {
  const lines = [];
  const reporter = { emit: (e) => lines.push(e.msg) };
  const falls = loaded([90, 90, 1]);
  const waited = await withSandboxHome(() =>
    withReporter(reporter, () => waitForHostLoadNow(falls, "linux")),
  );
  assert.equal(waited, "waited 30 s for host load");
  assert.deepEqual(falls.slept, [15000, 15000]);
  assert.match(
    lines.join("\n"),
    /waiting up to 1\.5 min for host load 90\.0 to fall to 8 \(budget\.host_load\) before with-temp-home; --no-wait skips/,
  );
});

test("waitForHostLoadNow: with-temp-home's wait stops at 90 s, under an agent's 2 min Bash timeout (SW-469)", async () => {
  const stuck = loaded([90]);
  const note = await withSandboxHome(() => waitForHostLoadNow(stuck, "linux"));
  assert.equal(stuck.slept.length, 6);
  assert.equal(note, "ran with host load 90.0 over 8; the 1.5 min host-load wait is spent");
});

// SW-556: macOS's loadavg counts idle daemons in R state (450-550 on a quiet host) and never the
// Linux VM that runs the tests, so with-temp-home has nothing to wait on there.
test("waitForHostLoadNow: on macOS it returns at once, whatever loadavg reads (SW-556)", async () => {
  const stuck = loaded([90]);
  assert.equal(await withSandboxHome(() => waitForHostLoadNow(stuck, "darwin")), "");
  assert.deepEqual(stuck.slept, []);
});

test("waitForHostLoadNow: prints progress at the minute, not at the end (SW-262)", async () => {
  const lines = [];
  const reporter = { emit: (e) => lines.push(e.msg) };
  const stuck = loaded([90]);
  await withSandboxHome(() => withReporter(reporter, () => waitForHostLoadNow(stuck, "linux")));
  assert.deepEqual(lines.slice(1), [
    "still waiting for host load: 90.0 over 8, 60 s so far, up to 0.5 min left",
  ]);
});

test("refreshPrStatus: merged, then shipped once a release tag contains the merge", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) },
  });
  try {
    const merged = [
      /^gh pr view/,
      { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc123" } }) },
    ];
    const stillOpen = deps([[/^gh pr view/, { stdout: JSON.stringify({ state: "OPEN" }) }]]);
    await refreshPrStatus(ws, stillOpen);
    assert.deepEqual(stillOpen.stopped, [], "a pass that records nothing new stops nothing");
    const d = deps([merged, [/tag --contains abc123 --list v\*/, { stdout: "" }]]);
    const m = await refreshPrStatus(ws, d);
    assert.equal(readPrFiles(ws)[0].fm.status, "merged");
    assert.deepEqual(d.stopped, [ws], "merged stops the containers (SW-39)");
    assert.ok(m.lines.includes("containers stopped"), m.lines.join("\n"));
    assert.equal(readPrFiles(ws)[0].fm.merge_sha, "abc123");
    const r = await refreshPrStatus(
      ws,
      deps([[/tag --contains abc123/, { stdout: "v1.2.0\nv1.3.0\n" }]]),
    );
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped");
    assert.equal(readPrFiles(ws)[0].fm.release, "v1.2.0");
    assert.ok(r.changed);
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: ship: merge ships on merge", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "merged", extra: "merge_sha: abc\n" }) },
  });
  try {
    await refreshPrStatus(
      ws,
      deps([], { repos: { app: { ...REGISTRY.repos.app, ship: "merge" } } }),
    );
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped");
  } finally {
    clean(ws);
  }
});

// --- SW-340: sync the machine registry when a merged PR changes its repo's fragment ----------
const FRAGMENT_CHANGED = [{ path: ".werkmeister/services.yaml" }, { path: "src/server.ts" }];
const mergedWith = (files) => [
  /^gh pr view/,
  { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc" }, files }) },
];
const sourceGit = ({ branch = "main", status = "" } = {}) => [
  [/rev-parse --abbrev-ref HEAD/, { stdout: `${branch}\n` }],
  [/status --porcelain --untracked-files=no/, { stdout: status }],
];
const autoRepos = { app: { ...REGISTRY.repos.app, sync_on_merge: "auto" } };
const openPr = () =>
  icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) } });

/** A temp HOME whose generated registry holds app's `node src/server.js`; *fn* gets `ship()`, which lands the PR's server.ts fragment in the checkout. */
async function withAppRegistry(fn) {
  const repos = fs.mkdtempSync(path.join(os.tmpdir(), "sw340-repos-"));
  const fragment = path.join(repos, "app", ".werkmeister", "services.yaml");
  fs.mkdirSync(path.dirname(fragment), { recursive: true });
  const write = (cmd) =>
    fs.writeFileSync(fragment, `services:\n  api:\n    path: apps/api\n    command: node ${cmd}\n`);
  write("src/server.js");
  try {
    return await withSandboxHome(
      async (home) => {
        // The fixture's registry is hand-written; generate it first, as machine setup does.
        assert.equal(syncRegistry({ reposRoot: repos })[0].ok, true);
        const registry = () => fs.readFileSync(path.join(home, "services.yaml"), "utf8");
        const sync = () => syncRegistry({ reposRoot: repos, generatedOnly: true });
        return await fn({ registry, sync, ship: () => write("src/server.ts") });
      },
      { config: `paths:\n  repos_root: ${repos}\n` },
    );
  } finally {
    fs.rmSync(repos, { recursive: true, force: true });
  }
}

test("SW-340 auto: a merged PR that changes the fragment pulls, syncs the registry and names the stale feature", async () => {
  const ws = openPr();
  try {
    await withAppRegistry(async ({ registry, sync, ship }) => {
      ship();
      const d = deps([mergedWith(FRAGMENT_CHANGED), ...sourceGit()], {
        repos: autoRepos,
        syncRegistry: sync,
        runningServices: () => [
          { feature: "feat", services: ["api", "lib"] },
          { feature: "other", services: ["web"] },
        ],
      });
      const r = await refreshPrStatus(ws, d);
      assert.ok(d.calls.includes("git -C /src/app pull --ff-only"), d.calls.join("\n"));
      assert.match(registry(), /node src\/server\.ts/);
      assert.ok(
        r.lines.includes("registry synced for app (https://x/pr/9): changed services.api"),
        r.lines.join("\n"),
      );
      assert.ok(
        r.lines.includes("feat runs changed api: run werkmeister feature up feat to apply"),
        r.lines.join("\n"),
      );
      assert.ok(!r.lines.some((l) => l.startsWith("other ")), r.lines.join("\n"));
      assert.equal(readPrFiles(ws)[0].fm.registry_sync, "synced");
    });
  } finally {
    clean(ws);
  }
});

test("SW-340 warn (default): only the notice, on pr status and the card; never repeated", async () => {
  const ws = openPr();
  try {
    await withAppRegistry(async ({ registry }) => {
      const before = registry();
      const d = deps([mergedWith(FRAGMENT_CHANGED), ...sourceGit()]);
      const r = await refreshPrStatus(ws, d);
      const notice = "registry sync needed: app fragment changed in https://x/pr/9";
      assert.ok(r.lines.includes(notice), r.lines.join("\n"));
      assert.ok(!d.calls.some((c) => c.startsWith("git -C /src/app")), d.calls.join("\n"));
      assert.equal(registry(), before);
      assert.equal(
        lifecycleOf(ws).prs[0].registry_sync,
        true,
        "the card reads the PR file, no agent flag",
      );
      assert.equal(readPrFiles(ws)[0].fm.registry_sync, "needed");
      const again = await refreshPrStatus(ws, deps([]));
      assert.ok(!again.lines.some((l) => l.includes("registry")), again.lines.join("\n"));
    });
  } finally {
    clean(ws);
  }
});

test("SW-340 auto, dirty checkout: notice only, then synced on a later pass once clean", async () => {
  const ws = openPr();
  try {
    await withAppRegistry(async ({ registry, sync, ship }) => {
      ship();
      const before = registry();
      const dirty = deps([mergedWith(FRAGMENT_CHANGED), ...sourceGit({ status: " M x\n" })], {
        repos: autoRepos,
      });
      const r = await refreshPrStatus(ws, dirty);
      assert.ok(
        r.lines.includes(
          "registry sync needed: app fragment changed in https://x/pr/9 (checkout has uncommitted changes)",
        ),
        r.lines.join("\n"),
      );
      assert.ok(!dirty.calls.some((c) => c.includes("pull")), dirty.calls.join("\n"));
      assert.equal(registry(), before);
      assert.equal(readPrFiles(ws)[0].fm.registry_sync, "needed");
      const later = await refreshPrStatus(
        ws,
        deps(sourceGit(), { repos: autoRepos, syncRegistry: sync }),
      );
      assert.equal(readPrFiles(ws)[0].fm.registry_sync, "synced", later.lines.join("\n"));
      assert.match(registry(), /node src\/server\.ts/);
    });
  } finally {
    clean(ws);
  }
});

test("SW-340 auto, checkout off the base branch: notice only, no pull", async () => {
  const ws = openPr();
  try {
    const d = deps([mergedWith(FRAGMENT_CHANGED), ...sourceGit({ branch: "feature/x" })], {
      repos: autoRepos,
    });
    const r = await refreshPrStatus(ws, d);
    assert.ok(
      r.lines.includes(
        "registry sync needed: app fragment changed in https://x/pr/9 (checkout is on feature/x, not main)",
      ),
      r.lines.join("\n"),
    );
    assert.ok(!d.calls.some((c) => c.includes("pull")), d.calls.join("\n"));
  } finally {
    clean(ws);
  }
});

test("SW-340: a merged PR that leaves the fragment alone does nothing new", async () => {
  const ws = openPr();
  try {
    const d = deps([mergedWith([{ path: "src/a.ts" }])], { repos: autoRepos });
    const r = await refreshPrStatus(ws, d);
    assert.equal(readPrFiles(ws)[0].fm.status, "merged");
    assert.equal(readPrFiles(ws)[0].fm.registry_sync, undefined);
    assert.ok(!r.lines.some((l) => l.includes("registry")), r.lines.join("\n"));
    assert.ok(!d.calls.some((c) => c.startsWith("git -C /src/app")), d.calls.join("\n"));
  } finally {
    clean(ws);
  }
});

test("SW-340: adoptPr of a merged PR that changed the fragment syncs under auto", async () => {
  const ws = icmWorkspace({ files: {} });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    await withAppRegistry(async ({ registry, sync, ship }) => {
      ship();
      const view = {
        url: "https://github.com/o/app/pull/140",
        headRefName: "other/fix",
        baseRefName: "main",
        title: "fix: the thing",
        state: "MERGED",
        mergeCommit: { oid: "abc" },
        files: FRAGMENT_CHANGED,
      };
      const d = deps(
        [
          [/^gh pr view 140 /, { stdout: JSON.stringify(view) }],
          [/ls-remote/, { code: 2 }],
          ...sourceGit(),
        ],
        { repos: autoRepos, syncRegistry: sync },
      );
      const r = await adoptPr(ws, { pr: "140" }, d);
      assert.equal(readPrFiles(ws)[0].fm.registry_sync, "synced", r.lines.join("\n"));
      assert.match(registry(), /node src\/server\.ts/);
    });
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: ship: tag ignores skip_release and waits for a release tag (#145)", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({
        status: "merged",
        extra: "merge_sha: abc\nskip_release: no container, checked on host\n",
      }),
    },
  });
  try {
    await refreshPrStatus(ws, deps([[/tag --contains abc/, { stdout: "" }]]));
    assert.equal(readPrFiles(ws)[0].fm.status, "merged");
    await refreshPrStatus(ws, deps([[/tag --contains abc/, { stdout: "v2.0.0\n" }]]));
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped");
    assert.equal(readPrFiles(ws)[0].fm.release, "v2.0.0");
  } finally {
    clean(ws);
  }
});

const NOTHING_TO_BUMP =
  "🦋  info NO packages to be bumped at patch\n🦋  ---\n🦋  info NO packages to be bumped at minor\n🦋  ---\n🦋  info NO packages to be bumped at major\n";
const BUMPS =
  "🦋  info Packages to be bumped at patch:\n🦋  info \n🦋  - werkmeister\n🦋  ---\n🦋  info NO packages to be bumped at minor\n🦋  ---\n🦋  info NO packages to be bumped at major\n";

test("openPrs: a release check with nothing to bump records release: none; one with a bump records nothing (SW-193)", async () => {
  for (const [out, want] of [
    [NOTHING_TO_BUMP, "none"],
    [BUMPS, undefined],
  ]) {
    const ws = icmWorkspace();
    try {
      const d = deps([
        DIFF_API,
        [/changeset status/, { stdout: out }],
        [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }],
      ]);
      const r = await open(ws, d);
      assert.ok(r.ok, r.lines.join("\n"));
      assert.equal(readPrFiles(ws)[0].fm.release, want);
    } finally {
      clean(ws);
    }
  }
});

test("refreshPrStatus: ship: tag with release: none ships on merge without a tag lookup (SW-193)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\nrelease: none\n" }) },
  });
  try {
    const merged = [
      /^gh pr view/,
      { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc123" } }) },
    ];
    const d = deps([merged, [/tag --contains/, { stdout: "" }]]);
    const r = await refreshPrStatus(ws, d);
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped", r.lines.join("\n"));
    assert.ok(!d.calls.some((c) => c.includes("tag --contains")), "no tag to wait for");
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: a merged skip_release PR ships (none) only when its diff has no changeset (SW-514)", async () => {
  const SKIP = "url: https://x/pr/9\nskip_release: tests only\n";
  const files = (n, ...paths) => [
    ...paths.map((p) => ({ path: p })),
    ...Array.from({ length: n }, (_, i) => ({ path: `test/${i}.mjs` })),
  ];
  const cases = [
    ["tests only", SKIP, files(1, ".changeset/README.md"), REGISTRY.repos.app, "shipped"],
    ["a changeset", SKIP, files(1, ".changeset/sw-1.md"), REGISTRY.repos.app, "merged"],
    ["100 files may hide one", SKIP, files(100), REGISTRY.repos.app, "merged"],
    ["no files listed", SKIP, undefined, REGISTRY.repos.app, "merged"],
    ["no skip_release", "url: https://x/pr/9\n", files(1), REGISTRY.repos.app, "merged"],
    ["release already set", `${SKIP}release: v1.0.0\n`, files(1), REGISTRY.repos.app, "merged"],
    [
      "another release tool",
      SKIP,
      files(1),
      { ...REGISTRY.repos.app, release_check: "npm run release:check" },
      "merged",
    ],
  ];
  for (const [label, extra, prFiles, repo, want] of cases) {
    const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra }) } });
    try {
      const view = { state: "MERGED", mergeCommit: { oid: "abc123" }, files: prFiles };
      const d = deps(
        [
          [/^gh pr view/, { stdout: JSON.stringify(view) }],
          [/tag --contains/, { stdout: "" }],
        ],
        { repos: { app: repo } },
      );
      const r = await refreshPrStatus(ws, d);
      const fm = readPrFiles(ws)[0].fm;
      assert.equal(fm.status, want, `${label}: ${r.lines.join("\n")}`);
      if (label === "tests only") assert.equal(fm.release, "none");
      if (label === "release already set") assert.equal(fm.release, "v1.0.0");
    } finally {
      clean(ws);
    }
  }
});

test("lifecycleOf: merged + release: none reads shipped after pr status, so close-out proceeds (SW-193)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "merged", extra: "merge_sha: abc\nrelease: none\n" }) },
  });
  try {
    const d = deps([]);
    await refreshPrStatus(ws, d);
    assert.equal(lifecycleOf(ws).state, "shipped");
  } finally {
    clean(ws);
  }
});

const MERGED_SKIP = prFile({
  status: "merged",
  extra: "merge_sha: abc1234\nskip_release: tests only\n",
});

test("refreshPrStatus: a merged PR with no containing tag says why, naming the latest tag (SW-389)", async () => {
  const ws = icmWorkspace({ files: { app: MERGED_SKIP } });
  try {
    const d = deps([
      [/tag --contains abc1234/, { stdout: "" }],
      [/for-each-ref/, { stdout: "v1.4.0 2026-11-03T16:26:00Z\n" }],
      [/log -1 --format=%cI abc1234/, { stdout: "2026-11-03T17:27:00Z\n" }],
    ]);
    const r = await refreshPrStatus(ws, d);
    assert.equal(readPrFiles(ws)[0].fm.status, "merged");
    const out = r.lines.join("\n");
    assert.match(
      out,
      /not shipped yet: no release tag contains abc1234; latest tag v1\.4\.0 \(2026-11-03T16:26:00Z\) predates the merge \(2026-11-03T17:27:00Z\)/,
    );
    // skip_release is set, so the line also names the fix for a PR that ships nothing (SW-393).
    assert.match(out, /release: none/);
    assert.ok(
      d.calls.some((c) => /fetch -q --tags origin/.test(c)),
      "tags fetched first",
    );
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: a newer tag that doesn't contain the merge says so (SW-389)", async () => {
  const ws = icmWorkspace({ files: { app: MERGED_SKIP } });
  try {
    const r = await refreshPrStatus(
      ws,
      deps([
        [/tag --contains abc1234/, { stdout: "" }],
        [/for-each-ref/, { stdout: "v1.4.1 2026-11-03T18:00:00Z\n" }],
        [/log -1 --format=%cI abc1234/, { stdout: "2026-11-03T17:27:00Z\n" }],
      ]),
    );
    assert.match(
      r.lines.join("\n"),
      /latest tag v1\.4\.1 \(2026-11-03T18:00:00Z\) does not contain the merge \(2026-11-03T17:27:00Z\)/,
    );
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: an empty merge_sha says the merge commit is unknown (SW-389)", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "merged", extra: 'merge_sha: ""\nskip_release: tests only\n' }),
    },
  });
  try {
    const d = deps([[/tag --contains/, { code: 1, stderr: "malformed object name" }]]);
    const out = (await refreshPrStatus(ws, d)).lines.join("\n");
    assert.match(
      out,
      /not shipped yet: merge commit unknown; if it ships nothing, set `release: none`/,
    );
    assert.ok(!d.calls.some((c) => /for-each-ref/.test(c)), "no tag lookup without a sha");
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: a merged PR whose tag exists ships and prints no reason line (SW-389)", async () => {
  const ws = icmWorkspace({ files: { app: MERGED_SKIP } });
  try {
    const r = await refreshPrStatus(ws, deps([[/tag --contains abc1234/, { stdout: "v1.5.0\n" }]]));
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped");
    assert.equal(readPrFiles(ws)[0].fm.release, "v1.5.0");
    assert.doesNotMatch(r.lines.join("\n"), /not shipped yet/);
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: a repo with no release tags says so instead of naming one (SW-389)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "merged", extra: "merge_sha: abc1234\n" }) },
  });
  try {
    const r = await refreshPrStatus(
      ws,
      deps([
        [/tag --contains abc1234/, { stdout: "" }],
        [/for-each-ref/, { stdout: "" }],
      ]),
    );
    const out = r.lines.join("\n");
    assert.match(out, /not shipped yet: no release tag contains abc1234; no tag matches v\* yet/);
    assert.doesNotMatch(out, /latest tag/);
    assert.doesNotMatch(out, /release: none/, "no skip_release, so no hint");
  } finally {
    clean(ws);
  }
});

test("removalBlockers: an open PR, unmerged commits; merged and closed-out are fine", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "open", extra: "url: u\n" }),
      lib: prFile({ status: "merged" }),
    },
  });
  const trees = [
    { repo: "app", dir: "/w/app" },
    { repo: "lib", dir: "/w/lib" },
    { repo: "other", dir: "/w/other" },
  ];
  try {
    const { run } = stubRun([
      [/rev-parse --abbrev-ref origin\/HEAD/, { stdout: "origin/main\n" }],
      [/rev-list --count origin\/main\.\.HEAD/, { stdout: "2\n" }],
    ]);
    assert.deepEqual(await removalBlockers(ws, trees, run), [
      "app: PR is open (u)",
      "other: 2 commit(s) not on origin/main and no merged PR",
    ]);
    fs.writeFileSync(path.join(ws, "closeout.md"), "x");
    assert.deepEqual(await removalBlockers(ws, trees, run), []);
  } finally {
    clean(ws);
  }
});

test("abandonWorkspace: unsettled files become abandoned with the reason; closeout.md records it", () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open" }), lib: prFile({ status: "shipped" }) },
  });
  try {
    abandonWorkspace(ws, "superseded by #140");
    const byDir = Object.fromEntries(readPrFiles(ws).map((f) => [f.dir, f.fm]));
    assert.equal(byDir.app.status, "abandoned");
    assert.equal(byDir.app.reason, "superseded by #140");
    assert.equal(byDir.lib.status, "shipped");
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /Abandoned: superseded by #140/,
    );
  } finally {
    clean(ws);
  }
});

// The machine's config.yaml names its own workspaces_root, so a throwaway one replaces it.
const inWorkspacesRoot = (ws, fn) =>
  withSandboxHome(() => fn(path.basename(ws)), {
    config: `paths:\n  workspaces_root: ${path.dirname(ws)}\n`,
  });

test("removeWorkspace refuses while a PR is open, before touching anything", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }) } });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    const err = await inWorkspacesRoot(ws, (name) =>
      removeWorkspace(name).then(
        () => null,
        (e) => e,
      ),
    );
    assert.ok(err instanceof WorkspaceError, String(err));
    assert.match(err.message, /app: PR is open/);
    assert.match(err.message, /workspace abandon "<reason>"/);
    assert.ok(fs.existsSync(ws));
  } finally {
    clean(ws);
  }
});

test("closeOut refuses before ship", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "merged" }) } });
  try {
    const err = await inWorkspacesRoot(ws, (name) =>
      closeOut(name, {}, deps([])).then(
        () => null,
        (e) => e,
      ),
    );
    assert.match(String(err), /is merged \(app: merged\)/);
    // No skip_release: it has a release entry, so it must wait for its tag (#145).
    assert.doesNotMatch(String(err), /release: none/);
    assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
  } finally {
    clean(ws);
  }
});

test("closeOut: a merged skip_release PR names the release: none fix (SW-393)", async () => {
  const ws = icmWorkspace({ files: { app: MERGED_SKIP } });
  try {
    const err = await inWorkspacesRoot(ws, (name) =>
      closeOut(name, {}, deps([])).then(
        () => null,
        (e) => e,
      ),
    );
    assert.match(String(err), /is merged \(app: merged\)/);
    assert.match(String(err), /skip_release that ships nothing .*`release: none` in its PR file/);
  } finally {
    clean(ws);
  }
});

test("closeOut: closes the issue, records, removes, then deletes merged branches", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({
        status: "shipped",
        extra: "url: https://x/pr/9\nmerge_sha: abc\nrelease: v1.2.0\n",
      }),
    },
  });
  try {
    const order = [];
    let issue = null;
    const d = deps([[/ls-remote/, { code: 2 }]], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async (ref, u) => (issue = [ref, u.status]),
      },
      remove: async () => {
        order.push("remove");
        assert.match(
          fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
          /\| o\/app \| https:\/\/x\/pr\/9 \| shipped \| abc \| v1\.2\.0 \|/,
        );
        return { output: "removed" };
      },
    });
    const origRun = d.run;
    d.run = async (bin, args) => {
      if (args.includes("branch")) order.push("branch -D");
      return origRun(bin, args);
    };
    const r = await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.deepEqual(issue, ["o/app#7", "closed"]);
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /^Post-mortem: postmortem\.md$/m,
    );
    assert.deepEqual(order, ["remove", "branch -D"]);
    assert.ok(d.calls.includes("git -C /src/app branch -D me/ws"));
    assert.ok(
      !d.calls.some((c) => c.includes("push origin --delete")),
      "remote already gone (ls-remote exit 2)",
    );
    assert.match(r.output, /origin\/me\/ws already gone/);
  } finally {
    clean(ws);
  }
});

test("closeOut --abandon: needs a reason", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }) } });
  try {
    const err = await inWorkspacesRoot(ws, (name) =>
      closeOut(name, { abandon: "  " }, deps([])).then(
        () => null,
        (e) => e,
      ),
    );
    assert.ok(err instanceof WorkspaceError, String(err));
    assert.match(err.message, /needs a reason/);
    assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
  } finally {
    clean(ws);
  }
});

const refusal = (ws, opts) =>
  inWorkspacesRoot(ws, (name) =>
    closeOut(
      name,
      opts,
      deps([], {
        tracker: {
          fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
          updateIssue: async () => assert.fail("issue moved"),
        },
        remove: async () => assert.fail("removed"),
      }),
    ).then(
      () => null,
      (e) => e,
    ),
  );

test("closeOut refuses without postmortem.md, before touching anything (SW-108)", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "shipped" }) }, postmortem: null });
  try {
    const err = await refusal(ws, {});
    assert.ok(err instanceof WorkspaceError, String(err));
    assert.match(err.message, /no postmortem\.md/);
    assert.match(err.message, /--skip-postmortem "<reason>"/);
    assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
  } finally {
    clean(ws);
  }
});

test("closeOut --abandon without postmortem.md refuses before abandoning the PR files (SW-108)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: u\n" }) },
    postmortem: null,
  });
  try {
    const err = await refusal(ws, { abandon: "superseded" });
    assert.match(
      String(err),
      /no postmortem\.md.*workspace abandon "<reason>" pr-life-\w+ --skip-postmortem/,
    );
    assert.match(
      fs.readFileSync(path.join(ws, "stages/03_propose/output/pr-app.md"), "utf8"),
      /status: open/,
    );
    assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
  } finally {
    clean(ws);
  }
});

test("closeOut unshipped and without postmortem.md: the ship refusal comes first (SW-108)", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "merged" }) }, postmortem: null });
  try {
    assert.match(String(await refusal(ws, {})), /is merged \(app: merged\)/);
  } finally {
    clean(ws);
  }
});

test("closeOut --skip-postmortem: needs a reason (SW-108)", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "shipped" }) }, postmortem: null });
  try {
    assert.match(String(await refusal(ws, { skipPostmortem: "  " })), /needs a reason/);
  } finally {
    clean(ws);
  }
});

test("closeOut --skip-postmortem: records the reason and closes out (SW-108)", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "shipped" }) }, postmortem: null });
  try {
    const r = await inWorkspacesRoot(ws, (name) =>
      closeOut(name, { skipPostmortem: "no time" }, deps([])),
    );
    assert.match(r.output, /removed/);
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /^Post-mortem skipped: no time$/m,
    );
  } finally {
    clean(ws);
  }
});

test("closeOut --abandon: records why, comments it and closes the issue as not planned, removes, keeps every branch, lists terminals", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "open", extra: "url: u\n" }),
      lib: prFile({ status: "shipped", extra: "url: https://x/pr/3\n" }),
    },
  });
  try {
    let updated = null;
    const d = deps([], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async (ref, u) => (updated = [ref, u]),
      },
      terminals: async (dir) => [`terminal session: pid 9 on ttys001 in ${dir} — /exit it`],
      remove: async (_name, abandoned) => ({ output: `removed abandoned=${abandoned}` }),
    });
    const r = await inWorkspacesRoot(ws, (name) =>
      closeOut(name, { abandon: "superseded by #170" }, d),
    );
    const closeout = fs.readFileSync(path.join(ws, "closeout.md"), "utf8");
    assert.match(closeout, /Abandoned: superseded by #170/);
    assert.match(closeout, /Issue: o\/app#7 → not planned/);
    assert.deepEqual(updated, [
      "o/app#7",
      { status: "not planned", comment: "Abandoned: superseded by #170" },
    ]);
    assert.ok(
      !d.calls.some((c) => c.includes("branch -D") || c.includes("--delete")),
      "abandon keeps every branch",
    );
    assert.match(r.output, /removed abandoned=true/, "remove skips pushing handoff-only branches");
    assert.deepEqual(r.terminals, [`terminal session: pid 9 on ttys001 in ${ws} — /exit it`]);
    assert.equal(r.path, ws);
    assert.match(r.command, /^werkmeister workspace abandon <reason> /);
  } finally {
    clean(ws);
  }
});

// ---- usage snapshot (SW-206) ------------------------------------------------------------------

/** A temp HOME whose Claude Code project dir for *ws* holds `{ id: [line objects] }` transcripts. */
async function withTranscripts(ws, sessions, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-home-"));
  const prev = process.env.HOME;
  const dir = path.join(home, ".claude", "projects", ws.replace(/[^a-zA-Z0-9]/g, "-"));
  const write = (more) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [id, lines] of Object.entries(more))
      fs.writeFileSync(
        path.join(dir, `${id}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n"),
      );
  };
  write(sessions);
  process.env.HOME = home;
  try {
    return await fn(write);
  } finally {
    process.env.HOME = prev;
    clean(home);
  }
}

const turn = (timestamp, model, usage) => ({
  type: "assistant",
  timestamp,
  message: { model, usage },
});
const TRANSCRIPTS = {
  s1: [
    { type: "user", timestamp: "2026-10-30T10:00:00.000Z" },
    turn("2026-10-30T10:01:00.000Z", "claude-sonnet-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    }),
    turn("2026-10-30T10:30:00.000Z", "claude-mystery", { input_tokens: 10, output_tokens: 5 }),
  ],
  s2: [
    turn("2026-10-30T11:00:00.000Z", "claude-sonnet-5", {
      cache_creation_input_tokens: 200_000,
      cache_read_input_tokens: 1_000_000,
    }),
  ],
};
const readUsage = (ws) => JSON.parse(fs.readFileSync(path.join(ws, "usage.json"), "utf8"));

test("closeOut writes usage.md + usage.json before removal, and a summary line in closeout.md", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: u\n" }) },
  });
  fs.appendFileSync(path.join(dotDir(ws), "workspace.yml"), "model: sonnet\nautonomous: true\n");
  try {
    let atRemoval = [];
    const d = deps([[/ls-remote/, { code: 2 }]], {
      remove: async () => {
        atRemoval = ["usage.md", "usage.json"].filter((f) => fs.existsSync(path.join(ws, f)));
        return { output: "removed" };
      },
    });
    await inWorkspacesRoot(ws, (name) =>
      withTranscripts(ws, TRANSCRIPTS, () => closeOut(name, {}, d)),
    );
    assert.deepEqual(atRemoval, ["usage.md", "usage.json"]);
    const u = readUsage(ws);
    assert.equal(u.schema, 1);
    assert.equal(u.outcome, "shipped");
    assert.equal(u.ticket, "o/app#7");
    assert.equal(u.model, "sonnet");
    assert.equal(u.autonomous, true);
    assert.deepEqual(u.totals, {
      input: 1_000_010,
      output: 100_005,
      cacheCreation: 200_000,
      cacheRead: 1_000_000,
    });
    // Only claude-sonnet-5 is priced: 3 + 1.5 + 0.75 + 0.3.
    assert.equal(u.estUsd.toFixed(2), "5.55");
    assert.equal(u.sessionCount, 2);
    assert.equal(u.turns, 3);
    assert.equal(u.firstTurn, "2026-10-30T10:00:00.000Z");
    const s1 = u.sessions.find((s) => s.sessionId === "s1");
    assert.equal(s1.lastTurn, "2026-10-30T10:30:00.000Z");
    assert.deepEqual(s1.models, ["claude-sonnet-5", "claude-mystery"]);
    assert.deepEqual(
      u.byModel.map((m) => [m.model, m.estUsd === null]),
      [
        ["claude-sonnet-5", false],
        ["claude-mystery", true],
      ],
    );
    assert.deepEqual(
      u.stages.map((s) => [s.stage, !!s.finishedAt]),
      [
        ["01_research", true],
        ["02_implement", true],
        ["03_propose", true],
      ],
    );
    assert.ok(!u.note);

    const md = fs.readFileSync(path.join(ws, "usage.md"), "utf8");
    assert.match(md, /^# Usage\n\nUsage: 2\.3M tokens, ~\$5\.55 across 2 sessions\n/);
    for (const h of ["## Tokens by model", "## Sessions", "## Stages"])
      assert.match(md, new RegExp(`^${h}`, "m"));
    assert.match(
      md,
      /^\| \*\*total\*\* \| 1,000,010 \| 100,005 \| 200,000 \| 1,000,000 \| \$5\.55 \|$/m,
    );
    assert.match(
      md,
      /^\| s1 \| .* \| 2 \| 1\.1M \| claude-sonnet-5, claude-mystery \| \$4\.50 \|$/m,
    );
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /^Usage: 2\.3M tokens, ~\$5\.55 across 2 sessions; see usage\.md$/m,
    );
  } finally {
    clean(ws);
  }
});

test("closeOut --abandon with no transcripts: the snapshot says so and close-out finishes", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }) } });
  try {
    const d = deps([]);
    const r = await inWorkspacesRoot(ws, (name) =>
      withTranscripts(ws, {}, () => closeOut(name, { abandon: "superseded" }, d)),
    );
    assert.match(r.output, /removed/);
    const u = readUsage(ws);
    assert.equal(u.outcome, "abandoned");
    assert.deepEqual(u.sessions, []);
    assert.equal(u.estUsd, null);
    assert.match(u.note, /no Claude Code transcripts/);
    assert.match(
      fs.readFileSync(path.join(ws, "usage.md"), "utf8"),
      /^Note: no Claude Code transcripts/m,
    );
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /^Usage: no transcripts found; see usage\.md$/m,
    );
  } finally {
    clean(ws);
  }
});

test("closeOut retry after a failed removal keeps the first usage snapshot", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: u\n" }) },
  });
  try {
    const failing = deps([[/ls-remote/, { code: 2 }]], {
      remove: async () => {
        throw new Error("Handoff failed");
      },
    });
    // Inside the sandbox home, which sets HOME itself (SW-433).
    await inWorkspacesRoot(ws, (name) =>
      withTranscripts(ws, TRANSCRIPTS, async (write) => {
        await assert.rejects(closeOut(name, {}, failing), /Handoff failed/);
        const first = fs.readFileSync(path.join(ws, "usage.json"), "utf8");
        const firstMd = fs.readFileSync(path.join(ws, "usage.md"), "utf8");
        write({ s3: [turn("2026-10-30T12:00:00.000Z", "claude-sonnet-5", { output_tokens: 1 })] });
        await closeOut(name, {}, deps([[/ls-remote/, { code: 2 }]]));
        assert.equal(fs.readFileSync(path.join(ws, "usage.json"), "utf8"), first);
        assert.equal(fs.readFileSync(path.join(ws, "usage.md"), "utf8"), firstMd);
        assert.match(
          fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
          /^Usage: .* across 2 sessions; see usage\.md$/m,
        );
      }),
    );
  } finally {
    clean(ws);
  }
});

test("closeOut retry after an abandon that failed to remove: still abandoned", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "abandoned", extra: "reason: gone\nurl: u\n" }) },
    postmortem: null,
  });
  fs.writeFileSync(path.join(ws, "closeout.md"), "# Close-out\n");
  try {
    let updated = false;
    const d = deps([], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async () => (updated = true),
      },
      remove: async (_name, abandoned) => ({ output: `removed abandoned=${abandoned}` }),
    });
    const r = await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.equal(updated, false);
    assert.match(r.output, /removed abandoned=true/);
  } finally {
    clean(ws);
  }
});

/** A tracker stub whose issue sits at *status* / *labels*; records every update. */
function issueAt(status, labels = []) {
  const updates = [];
  return {
    updates,
    fetchIssue: async () => ({
      ref: "o/app#7",
      status,
      labels,
      ...(status === "Closed" ? { statusCategory: "done" } : {}),
    }),
    updateIssue: async (ref, u) => updates.push([ref, u.status, u.comment]),
  };
}

const prView = (view) => [/^gh pr view/, { stdout: JSON.stringify(view) }];

test("refreshPrStatus: shipped moves the issue to done with the release (SW-27)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) },
  });
  try {
    const tracker = issueAt("Open", ["Peer Review"]);
    const r = await refreshPrStatus(
      ws,
      deps(
        [
          prView({ state: "MERGED", mergeCommit: { oid: "abc" } }),
          [/tag --contains abc/, { stdout: "v1.2.0\n" }],
        ],
        { tracker },
      ),
    );
    assert.deepEqual(tracker.updates, [["o/app#7", "closed", "Shipped: v1.2.0 — https://x/pr/9"]]);
    assert.ok(r.lines.includes("issue o/app#7 → closed"), r.lines.join("\n"));
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: a PR closed without merging moves the issue back to in progress", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) },
  });
  try {
    const tracker = issueAt("Open", ["Peer Review"]);
    await refreshPrStatus(ws, deps([prView({ state: "CLOSED" })], { tracker }));
    assert.deepEqual(tracker.updates, [
      ["o/app#7", "status: in progress", "PR closed without merging: https://x/pr/9"],
    ]);
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: changes requested moves back once; the review clearing returns it to review", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) },
  });
  try {
    // A repo with no required review leaves reviewDecision empty; latestReviews still says it.
    const asked = prView({
      state: "OPEN",
      reviewDecision: "",
      latestReviews: [{ state: "CHANGES_REQUESTED" }],
    });
    const inReview = issueAt("Open", ["Peer Review"]);
    const r = await refreshPrStatus(ws, deps([asked], { tracker: inReview }));
    assert.deepEqual(inReview.updates, [
      ["o/app#7", "status: in progress", "Changes requested: https://x/pr/9"],
    ]);
    assert.equal(readPrFiles(ws)[0].fm.review, "changes_requested");
    assert.ok(r.changed, "the review field is recorded");

    const again = issueAt("Open", ["status: in progress"]);
    await refreshPrStatus(ws, deps([asked], { tracker: again }));
    assert.deepEqual(again.updates, [], "the same review moves the issue once");

    const back = issueAt("Open", ["status: in progress"]);
    await refreshPrStatus(
      ws,
      deps(
        [
          prView({
            state: "OPEN",
            reviewDecision: "APPROVED",
            latestReviews: [{ state: "APPROVED" }],
          }),
        ],
        {
          tracker: back,
        },
      ),
    );
    assert.deepEqual(back.updates, [["o/app#7", "Peer Review", "Back in review: https://x/pr/9"]]);
    assert.equal(readPrFiles(ws)[0].fm.review, undefined);
  } finally {
    clean(ws);
  }
});

test("closeOut: a tracker refusal is a warning, close-out still records and removes", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: https://x/pr/9\nmerge_sha: abc\n" }) },
  });
  try {
    let removed = false;
    const d = deps([[/ls-remote/, { code: 2 }]], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "Open", labels: [] }),
        updateIssue: async () => {
          throw new Error("HTTP 403: Resource not accessible");
        },
      },
      remove: async () => {
        removed = true;
        return { output: "removed" };
      },
    });
    const r = await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.ok(removed);
    assert.match(r.output, /Issue: o\/app#7 not moved to "closed": HTTP 403/);
    assert.match(fs.readFileSync(path.join(ws, "closeout.md"), "utf8"), /not moved to "closed"/);
  } finally {
    clean(ws);
  }
});

test("closeOut: an overlapping run says close-out is already running, and a later one already closed out", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: https://x/pr/9\nmerge_sha: abc\n" }) },
  });
  try {
    let removes = 0;
    let entered;
    let release;
    const inRemove = new Promise((r) => (entered = r));
    const held = new Promise((r) => (release = r));
    const d = deps([[/ls-remote/, { code: 2 }]], {
      remove: async () => {
        if (removes++ === 0) {
          entered();
          await held;
          fs.rmSync(ws, { recursive: true, force: true });
        }
        return { output: "removed" };
      },
    });
    await inWorkspacesRoot(ws, async (name) => {
      const first = closeOut(name, {}, d);
      await inRemove;
      await assert.rejects(closeOut(name, {}, d), /close-out of '.+' is already running/);
      release();
      await first;
      await assert.rejects(closeOut(name, {}, d), /already closed out/);
    });
    assert.equal(removes, 1);
  } finally {
    clean(ws);
  }
});

test("closeOut: the folder gone by the closeout.md write reports already closed out, not ENOENT", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: https://x/pr/9\nmerge_sha: abc\n" }) },
  });
  try {
    let removed = false;
    const d = deps([[/ls-remote/, { code: 2 }]], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        // Another remover finishes while the issue moves, just before the write.
        updateIssue: async () => fs.rmSync(ws, { recursive: true, force: true }),
      },
      remove: async () => {
        removed = true;
        return { output: "removed" };
      },
    });
    const r = await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.match(r.output, /already closed out/);
    assert.ok(!removed);
  } finally {
    clean(ws);
  }
});

test("openTerminalSessions: TTY claude processes whose cwd is in the workspace", async () => {
  const ps =
    "  11   1 ttys001  /usr/local/bin/claude\n  12   1 ??       claude\n  13   1 ttys002  claude\n  14   1 ttys003  zsh\n  15   1 ttys004  claude\n";
  const lsof = "p11\nfcwd\nn/ws/a/repo\np13\nfcwd\nn/ws/ab\np15\nfcwd\nn/ws/a\n";
  const r = stubRun([
    [/^ps /, { stdout: ps }],
    [/^lsof /, { stdout: lsof, code: 1 }],
  ]);
  const out = await openTerminalSessions("/ws/a", r.run, "/nonexistent");
  assert.deepEqual(out, [
    "terminal session: pid 11 on ttys001 in /ws/a/repo — /exit it",
    "terminal session: pid 15 on ttys004 in /ws/a — /exit it",
  ]);
  assert.ok(r.calls.includes("lsof -a -d cwd -Fpn -p 11,13,15"));
  assert.deepEqual(await openTerminalSessions("/ws/a", stubRun([[/^ps /, { code: 1 }]]).run), []);
});

test("SW-421: openTerminalSessions skips sessions the VS Code extension owns", async () => {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-terminals-"));
  try {
    fs.writeFileSync(path.join(owned, "500"), "/ws/a/repo");
    fs.writeFileSync(path.join(owned, "700"), "/ws/b"); // the extension shell is in another workspace
    const ps = "  11 500 ttys001  claude\n  15 600 ttys004  claude\n  16 700 ttys005  claude\n";
    const r = stubRun([
      [/^ps /, { stdout: ps }],
      [/^lsof /, { stdout: "p15\nfcwd\nn/ws/a\np16\nfcwd\nn/ws/a\n" }],
    ]);
    assert.deepEqual(await openTerminalSessions("/ws/a", r.run, owned), [
      "terminal session: pid 15 on ttys004 in /ws/a — /exit it",
      "terminal session: pid 16 on ttys005 in /ws/a — /exit it",
    ]);
    assert.ok(r.calls.includes("lsof -a -d cwd -Fpn -p 15,16"));
    releaseVscodeSessions("/ws/a", owned);
    assert.deepEqual(fs.readdirSync(owned), ["700"]);
  } finally {
    fs.rmSync(owned, { recursive: true, force: true });
  }
});

test("PR file: invalid YAML names the parser's error", () => {
  // A plain scalar cannot start with `@` (reserved YAML indicator); that is what makes this invalid.
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "shipped", extra: "release: @scope/pkg@0.7.0\n" }),
    },
  });
  try {
    assert.throws(() => readPrFiles(ws), /needs YAML frontmatter.*YAML error: .*reserved/s);
  } finally {
    clean(ws);
  }
});

test("adoptPr: a merged PR from outside is written, shipped by its release tag, and close-out keeps its branch", async () => {
  const ws = icmWorkspace({ files: {} });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    const view = {
      url: "https://github.com/o/app/pull/140",
      headRefName: "other/fix",
      baseRefName: "main",
      title: "fix: the thing",
      state: "MERGED",
      mergeCommit: { oid: "abc" },
    };
    const committed = [];
    const d = deps(
      [
        [/^gh pr view 140 /, { stdout: JSON.stringify(view) }],
        [/tag --contains abc --list v\*/, { stdout: "v0.7.0\n" }],
        [/ls-remote/, { code: 2 }],
      ],
      {
        commitRecord: async (_ws, _m, paths) => {
          committed.push(...paths);
          return { ok: true, message: "record pushed" };
        },
      },
    );
    const r = await adoptPr(ws, { pr: "140" }, d);
    assert.ok(r.ok);
    const [f] = readPrFiles(ws);
    assert.equal(f.dir, "app");
    assert.equal(f.title, "fix: the thing");
    assert.deepEqual(
      {
        repo: f.fm.repo,
        branch: f.fm.branch,
        base: f.fm.base,
        url: f.fm.url,
        merge_sha: f.fm.merge_sha,
        status: f.fm.status,
        release: f.fm.release,
      },
      {
        repo: "o/app",
        branch: "other/fix",
        base: "main",
        url: view.url,
        merge_sha: "abc",
        status: "shipped",
        release: "v0.7.0",
      },
    );
    assert.ok(committed.includes("stages/03_propose/output/pr-app.md"));
    await assert.rejects(adoptPr(ws, { pr: "140" }, d), /already tracked in pr-app.md/);

    const out = await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /\| o\/app \| https:\/\/github\.com\/o\/app\/pull\/140 \| shipped \| abc \| v0\.7\.0 \|/,
    );
    assert.ok(
      !d.calls.some((c) => c.includes("branch -D")),
      "an adopted PR's branch is not the workspace's to delete",
    );
    assert.match(out.output, /removed/);
  } finally {
    clean(ws);
  }
});

test("adoptPr --no-pr: a closed PR file with the reason; close-out then runs", async () => {
  const ws = icmWorkspace({ files: {} });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    const d = deps([]);
    await assert.rejects(adoptPr(ws, { noPr: " " }, d), /needs a reason/);
    await adoptPr(ws, { noPr: "fixed on main by 25957ae" }, d);
    const [f] = readPrFiles(ws);
    assert.equal(f.fm.status, "closed");
    assert.equal(f.fm.reason, "fixed on main by 25957ae");
    assert.ok(!d.calls.some((c) => c.startsWith("gh ")));
    assert.equal(lifecycleOf(ws).state, "shipped");
    await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.match(
      fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
      /\| app \| — \| closed \| — \| — \| fixed on main by 25957ae \|/,
    );
  } finally {
    clean(ws);
  }
});

test("adoptPr: refuses a closed-unmerged PR and an ambiguous repo", async () => {
  const ws = icmWorkspace({ files: {} });
  try {
    await assert.rejects(adoptPr(ws, { pr: "9" }, deps([])), /no code worktree/);
    fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
    const closed = {
      url: "https://github.com/o/app/pull/9",
      headRefName: "x",
      baseRefName: "main",
      title: "t",
      state: "CLOSED",
      mergeCommit: null,
    };
    await assert.rejects(
      adoptPr(ws, { pr: "9" }, deps([[/^gh pr view/, { stdout: JSON.stringify(closed) }]])),
      /is CLOSED, not merged.*--no-pr/,
    );
    assert.deepEqual(readPrFiles(ws), []);
  } finally {
    clean(ws);
  }
});

// ---- PR callbacks (#236) ---------------------------------------------------

const URL9 = "https://github.com/o/app/pull/9";
const MERGED = [
  /^gh pr view/,
  { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc123" } }) },
];
const NO_TAG = [/tag --contains/, { stdout: "" }];
const callbackFile = (extra = "") =>
  prFile({ status: "open", extra: `url: ${URL9}\nsession: s-1\n${extra}` });
const lockIn = (ws) => path.join(ws, "watch.lock");
const claim = (ws, d, desktop = false) => claimCallbacks([ws], { desktop }, d, lockIn(ws));
// Reading GitHub and tags only: never a merge, a close-out or a push.
const onlyReads = (calls) =>
  calls.every((c) => /^(gh pr view|git -C \S+ (fetch|tag|for-each-ref|log) )/.test(c));

/**
 * A temp HOME whose `~/.claude/projects` holds one transcript per `{ id: cwd }`, filed the
 * way Claude Code files them (by start folder), and a fake `claude` that logs `pwd` + argv.
 */
async function withClaudeHome(sessions, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  const prev = { HOME: process.env.HOME, CLAUDE_BIN: process.env.CLAUDE_BIN };
  for (const [id, cwd] of Object.entries(sessions)) {
    const dir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `{"type":"summary"}\n${JSON.stringify({ type: "user", cwd, sessionId: id })}\n`,
    );
  }
  const log = path.join(home, "claude.log");
  const bin = path.join(home, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\n{ pwd -P; echo "$@"; } >> "${log}"\n`, { mode: 0o755 });
  process.env.HOME = home;
  process.env.CLAUDE_BIN = bin;
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  try {
    // `claude` is spawned detached and may outlive deliverHeadless's 2.5 s grace: under the full
    // suite macOS's first-exec check on a fresh stub took up to 10 s (SW-67). Wait for `min` lines.
    return await fn(async (min = 0) => {
      for (const end = Date.now() + 30_000; read().length < min && Date.now() < end; )
        await sleep(50);
      return read();
    });
  } finally {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    clean(home);
  }
}

// ---- spikes (SW-83): PR files in the last stage's output -----------------------

/** A temp spike workspace: 01_questions (done), 02_findings holding the PR files. */
function spikeWorkspace({ files = {}, postmortem = "Problems: none\n" } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-spike-"));
  const out = (d) => path.join(ws, "stages", d, "output");
  for (const d of ["01_questions", "02_findings"]) fs.mkdirSync(out(d), { recursive: true });
  fs.writeFileSync(path.join(out("01_questions"), "questions.md"), "status: decided\n");
  fs.writeFileSync(path.join(out("02_findings"), "findings.md"), "x");
  for (const [dir, text] of Object.entries(files))
    fs.writeFileSync(path.join(out("02_findings"), `pr-${dir}.md`), text);
  fs.mkdirSync(dotDir(ws), { recursive: true });
  fs.writeFileSync(
    path.join(dotDir(ws), "workspace.yml"),
    "feature: feat\nservices: api,lib\nissue_id: o/app#7\nwork_type: spike\n",
  );
  fs.writeFileSync(path.join(ws, ".env"), "FEATURE=feat\nSANDBOX_SLOT=1\n");
  if (postmortem !== null) fs.writeFileSync(path.join(ws, "postmortem.md"), postmortem);
  return ws;
}

const DIFF_DOCS = [/diff --name-only/, { stdout: "docs/research/x.md\n" }];
const SKIP_EXERCISE = "skip_exercise: a doc, nothing to run\n";

test("spike: a doc PR file in 02_findings passes the gate with skip_exercise and opens", async () => {
  const ws = spikeWorkspace({ files: { app: prFile({ extra: SKIP_EXERCISE }) } });
  try {
    assert.equal(readPrFiles(ws)[0].path, path.join(ws, "stages/02_findings/output/pr-app.md"));
    assert.equal(lifecycleOf(ws).state, "ready");
    const g = await gate(ws, deps([DIFF_DOCS]));
    assert.deepEqual(failed(g), []);
    assert.equal(
      g.checks.find((c) => c.name === "exercise").detail,
      "skipped: a doc, nothing to run",
    );
    assert.equal(
      g.checks.find((c) => c.name === "stages").detail,
      "every earlier stage has output",
    );

    let recorded = null;
    const d = deps(
      [DIFF_DOCS, [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }]],
      {
        commitRecord: async (_ws, _msg, paths) => {
          recorded = paths;
          return { ok: true, message: "record pushed" };
        },
      },
    );
    const r = await open(ws, d);
    assert.ok(r.ok, r.lines.join("\n"));
    assert.equal(readPrFiles(ws)[0].fm.url, "https://github.com/o/app/pull/9");
    assert.deepEqual(recorded, [
      "stages/02_findings/output/pr-app.md",
      ".werkmeister/gate-app-release.log",
    ]);
  } finally {
    clean(ws);
  }
});

test("gate: skip_exercise needs a non-empty reason", async () => {
  const blank = noExercise({ files: { app: prFile({ extra: 'skip_exercise: " "\n' }) } });
  try {
    const g = await gate(blank, deps([DIFF_API]));
    assert.deepEqual(
      g.checks.find((c) => c.name === "exercise"),
      {
        name: "exercise",
        ok: false,
        detail: "no exercise.md — record the exercise checks first",
      },
    );
  } finally {
    clean(blank);
  }
});

test("spike with no PR file: gate and open say which file to write and where the format is", async () => {
  const ws = spikeWorkspace();
  try {
    const where = path.join(ws, "stages", "02_findings", "output");
    const msg = (rules) =>
      `No matching PR file in ${where}. Write pr-<worktree>[-<slug>].md there (format: ${rules}) and have the person set status: approved.`;
    await assert.rejects(
      withSandboxHome(() => gatePrs(ws, undefined, deps([]))),
      {
        message: msg("docs/workspace-lifecycle.md in the werkmeister repo"),
      },
    );
    fs.mkdirSync(path.join(ws, "_shared"));
    fs.writeFileSync(path.join(ws, "_shared", "pr-rules.md"), "x");
    await assert.rejects(open(ws, deps([])), { message: msg("_shared/pr-rules.md") });
  } finally {
    clean(ws);
  }
});

test("spike: adoptPr writes its PR file into 02_findings", async () => {
  const ws = spikeWorkspace();
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    await adoptPr(ws, { noPr: "landed by hand in #12" }, deps([]));
    const [f] = readPrFiles(ws);
    assert.equal(f.path, path.join(ws, "stages/02_findings/output/pr-app.md"));
    assert.equal(f.fm.status, "closed");
  } finally {
    clean(ws);
  }
});

test("spike close-out: with a PR file it waits for ship then takes the PR path; without one it closes as before", async () => {
  const open_ = spikeWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }) } });
  try {
    const err = await inWorkspacesRoot(open_, (name) =>
      closeOut(name, {}, deps([])).then(
        () => null,
        (e) => e,
      ),
    );
    assert.match(
      String(err),
      /is pr-open \(app: open\)/,
      "no spike shortcut once a PR file exists",
    );
  } finally {
    clean(open_);
  }

  const shipped = spikeWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: https://x/pr/9\nmerge_sha: abc\n" }) },
  });
  try {
    let issue = null;
    const d = deps([[/ls-remote/, { code: 2 }]], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async (ref, u) => (issue = [ref, u.status]),
      },
    });
    await inWorkspacesRoot(shipped, (name) => closeOut(name, {}, d));
    assert.deepEqual(issue, ["o/app#7", "closed"]);
    assert.match(
      fs.readFileSync(path.join(shipped, "closeout.md"), "utf8"),
      /\| o\/app \| https:\/\/x\/pr\/9 \| shipped \| abc \|/,
    );
    assert.ok(d.calls.includes("git -C /src/app branch -D me/ws"), "merged branch deleted");
  } finally {
    clean(shipped);
  }

  const bare = spikeWorkspace();
  try {
    await inWorkspacesRoot(bare, (name) => closeOut(name, {}, deps([])));
    assert.ok(fs.existsSync(path.join(bare, "closeout.md")));
  } finally {
    clean(bare);
  }
});

// ---- no PR needed (SW-270): the fix lived outside every repo ----------------------

/** A finished ICM workspace with no PR files and one code worktree, `app`. */
function noPrWorkspace(opts = {}) {
  const ws = icmWorkspace({ files: {}, ...opts });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  return ws;
}
const rejection = (p) =>
  p.then(
    () => null,
    (e) => e,
  );

test("closeOut --no-pr: a clean, untouched workspace closes as done, not abandoned (SW-270)", async () => {
  const ws = noPrWorkspace();
  try {
    let issue = null;
    const d = deps([[/rev-list --count/, { stdout: "0\n" }]], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async (ref, u) => (issue = [ref, u.status, u.comment]),
      },
    });
    await inWorkspacesRoot(ws, (name) => closeOut(name, { noPr: "fix lived in ~/.claude" }, d));
    assert.deepEqual(issue?.slice(0, 2), ["o/app#7", "closed"]);
    assert.match(issue[2], /No PR needed: fix lived in ~\/\.claude/);
    const closeout = fs.readFileSync(path.join(ws, "closeout.md"), "utf8");
    assert.match(closeout, /^No PR needed: fix lived in ~\/\.claude$/m);
    assert.doesNotMatch(closeout, /Abandoned/);
    assert.equal(readUsage(ws).outcome, "shipped");
  } finally {
    clean(ws);
  }
});

test("closeOut --no-pr refuses dirty, ahead-of-main or un-post-mortemed workspaces, changing nothing (SW-270)", async () => {
  const cases = [
    [{}, [[/status --porcelain/, { stdout: " M src/x.ts\n" }]], /app: uncommitted changes/],
    [{}, [[/rev-list --count/, { stdout: "2\n" }]], /app: 2 commit\(s\) not on origin\/main/],
    [{}, [[/rev-list --count/, { code: 128 }]], /app: can't tell/],
    [{ postmortem: null }, [], /has no postmortem\.md/],
  ];
  for (const [opts, table, re] of cases) {
    const ws = noPrWorkspace(opts);
    try {
      const err = await inWorkspacesRoot(ws, (name) =>
        rejection(closeOut(name, { noPr: "outside every repo" }, deps(table))),
      );
      assert.ok(err instanceof WorkspaceError, String(err));
      assert.match(err.message, re);
      assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
    } finally {
      clean(ws);
    }
  }
  // --no-pr is for a workspace with no PR files; one with PRs takes the normal path.
  const withPr = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }) } });
  try {
    const err = await inWorkspacesRoot(withPr, (name) =>
      rejection(closeOut(name, { noPr: "x" }, deps([]))),
    );
    assert.match(String(err), /has PR files/);
  } finally {
    clean(withPr);
  }
});

test("closeOut without --no-pr: a no-PR workspace's refusal names --no-pr beside abandon (SW-270)", async () => {
  const ws = noPrWorkspace();
  try {
    const err = await inWorkspacesRoot(ws, (name) => rejection(closeOut(name, {}, deps([]))));
    assert.match(String(err), /is working \(no PR files\)/);
    assert.match(String(err), /--no-pr "<reason>"/);
    assert.match(String(err), /workspace abandon "<reason>"/);
  } finally {
    clean(ws);
  }
});

test("callbackFields: both ids from the env, no host id outside the desktop app", () =>
  withClaudeHome({}, async () => {
    assert.deepEqual(
      await callbackFields("/nowhere/ws", {
        CLAUDE_CODE_SESSION_ID: "s-1",
        CLAUDE_CODE_HOST_SESSION_ID: "local_h1",
      }),
      { session: "s-1", host_session: "local_h1" },
    );
    assert.deepEqual(await callbackFields("/nowhere/ws", { CLAUDE_CODE_SESSION_ID: "s-1" }), {
      session: "s-1",
    });
  }));

test("callbackMessage: the issue's texts", () => {
  assert.equal(
    callbackMessage("merged", URL9),
    `PR ${URL9} merged. Run \`werkmeister pr status\`, then follow the workspace router.`,
  );
  assert.equal(
    callbackMessage("shipped", URL9, "v1.2.0"),
    `PR ${URL9} shipped in v1.2.0. Ask the person whether to run \`werkmeister workspace close\`.`,
  );
  assert.equal(callbackMessage("closed", URL9), `PR ${URL9} was closed. Report it to the person.`);
  assert.equal(callbackMessage("open", URL9), null);
  assert.equal(callbackMessage("abandoned", URL9), null);
});

test("claimCallbacks: ship: tag — merged once, then shipped with its tag, then the callback is gone", async () => {
  const ws = icmWorkspace({ files: { app: callbackFile() } });
  try {
    const d1 = deps([MERGED, NO_TAG]);
    const first = await claim(ws, d1);
    assert.deepEqual(
      first.claimed.map((c) => [c.session, c.hostSession, c.message]),
      [["s-1", null, callbackMessage("merged", URL9)]],
    );
    assert.equal(readPrFiles(ws)[0].fm.notified, "merged");

    const d2 = deps([NO_TAG]);
    assert.deepEqual((await claim(ws, d2)).claimed, [], "no second merged message");

    const d3 = deps([[/tag --contains abc123/, { stdout: "v1.2.0\n" }]]);
    const shipped = await claim(ws, d3);
    assert.deepEqual(
      shipped.claimed.map((c) => c.message),
      [callbackMessage("shipped", URL9, "v1.2.0")],
    );
    const fm = readPrFiles(ws)[0].fm;
    assert.equal(fm.status, "shipped");
    assert.ok(!("session" in fm) && !("notified" in fm), "settled: the callback is removed");

    const d4 = deps([]);
    assert.deepEqual((await claim(ws, d4)).claimed, []);
    assert.deepEqual(d4.calls, [], "a removed callback costs no gh call");
    for (const d of [d1, d2, d3]) assert.ok(onlyReads(d.calls), d.calls.join("\n"));
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: closed without merge tells the session and drops the callback", async () => {
  const ws = icmWorkspace({ files: { app: callbackFile() } });
  try {
    const d = deps([[/^gh pr view/, { stdout: JSON.stringify({ state: "CLOSED" }) }]]);
    const r = await claim(ws, d);
    assert.deepEqual(
      r.claimed.map((c) => c.message),
      [callbackMessage("closed", URL9)],
    );
    assert.ok(!("session" in readPrFiles(ws)[0].fm));
    assert.ok(onlyReads(d.calls), d.calls.join("\n"));
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: ship: merge goes open → shipped in one pass and owes one message", async () => {
  const ws = icmWorkspace({ files: { app: callbackFile() } });
  try {
    const d = deps([MERGED], { repos: { app: { ...REGISTRY.repos.app, ship: "merge" } } });
    const r = await claim(ws, d);
    assert.deepEqual(
      r.claimed.map((c) => c.message),
      [callbackMessage("shipped", URL9)],
    );
    assert.ok(!("session" in readPrFiles(ws)[0].fm));
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a desktop callback is the mod's alone", async () => {
  const ws = icmWorkspace({ files: { app: callbackFile("host_session: local_h1\n") } });
  try {
    const cli = deps([MERGED]);
    assert.deepEqual((await claim(ws, cli)).claimed, []);
    assert.deepEqual(cli.calls, [], "the CLI pass does not even refresh it");
    assert.equal(readPrFiles(ws)[0].fm.status, "open");
    const mod = await claim(ws, deps([MERGED, NO_TAG]), true);
    assert.deepEqual(
      mod.claimed.map((c) => c.hostSession),
      ["local_h1"],
    );
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a held lock claims nothing; a stale one is taken over", async () => {
  const ws = icmWorkspace({ files: { app: callbackFile() } });
  try {
    fs.writeFileSync(lockIn(ws), "");
    const held = deps([MERGED]);
    assert.deepEqual((await claim(ws, held)).claimed, []);
    assert.deepEqual(held.calls, []);
    assert.ok(fs.existsSync(lockIn(ws)), "another pass's lock is left alone");
    const old = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(lockIn(ws), old, old);
    assert.equal((await claim(ws, deps([MERGED, NO_TAG]))).claimed.length, 1);
    assert.ok(!fs.existsSync(lockIn(ws)), "released after the pass");
  } finally {
    clean(ws);
  }
});

// ---- Open-PR wakes (SW-160) ----

const SHA1 = "1111111";
const SHA2 = "2222222";
const JOB = (n) => `https://github.com/o/app/actions/runs/5/job/${n}`;
const run = (name, conclusion, job = 1) => ({
  __typename: "CheckRun",
  name,
  conclusion,
  detailsUrl: JOB(job),
});
const openView = (over = {}) =>
  prView({
    state: "OPEN",
    number: 9,
    headRefOid: SHA1,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    ...over,
  });
const LOG = [
  "test\tRun tests\t2026-10-31T10:00:00.1234567Z ##[group]Run pnpm test",
  "test\tRun tests\t2026-10-31T10:00:01.0000000Z warning: deprecated flag",
  "test\tRun tests\t2026-10-31T10:00:02.0000000Z src/a.ts:12:5 - error TS2322: bad type",
  "test\tRun tests\t2026-10-31T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
].join("\n");
const JOB_LOG = [/^gh run view --job 1 /, { stdout: LOG }];
const INLINE = (items) => [
  /^gh api repos\/o\/app\/pulls\/9\/comments/,
  { stdout: JSON.stringify(items) },
];
// Past pr open's own mark, so a review after it is news.
const openFile = (extra = "") => callbackFile(`notified_review: "2026-10-31T09:00:00Z"\n${extra}`);
const wakes = (r) => r.claimed.map((c) => c.message);

test("failureExcerpt: strips job, step and time, drops warnings, keeps file:line", () => {
  assert.equal(
    failureExcerpt(LOG),
    "src/a.ts:12:5 - error TS2322: bad type\nerror: Process completed with exit code 1.",
  );
  assert.equal(
    failureExcerpt("j\ts\t2026-10-31T10:00:00Z one\nj\ts\t2026-10-31T10:00:01Z two"),
    "one\ntwo",
    "no error line: the tail",
  );
});

test("wakeMessage: each event opens with the ticket's sentence, all in one message", () => {
  const m = wakeMessage(URL9, [
    {
      kind: "conflict",
      base: "main",
      moved: "abc fix: x",
      dir: "/w/app",
      branch: "me/ws",
      head: "abc",
    },
    { kind: "review", quote: "ann: rename it" },
    { kind: "check", name: "test", cause: "src/a.ts:1 error" },
  ]);
  assert.equal(
    m,
    [
      `check test failed on PR ${URL9}, fix it.\n  Cause:\n    src/a.ts:1 error`,
      `address the review on PR ${URL9}:\n    ann: rename it`,
      [
        `PR ${URL9} conflicts with main, resolve it.\n  Base moved:\n    abc fix: x`,
        "  Rebase, never merge main in (GitHub can't rebase-merge a branch with a merge from its base):",
        "    git -C /w/app fetch origin main && git -C /w/app rebase origin/main",
        "  A conflict in a generated file (a snapshot, a lockfile): take main's copy and regenerate it; never hand-merge it.",
        "  You can't force-push: give the person",
        "    git -C /w/app push --force-with-lease=me/ws:abc",
      ].join("\n"),
      "Follow the workspace router; push the fix to the PR's branch.",
    ].join("\n\n"),
  );
});

test("claimCallbacks: a failed check wakes once with its cause; the next pass sends nothing", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    const view = openView({
      statusCheckRollup: [run("test", "FAILURE"), run("lint", "SUCCESS", 2)],
    });
    const r = await claim(ws, deps([view, JOB_LOG]));
    assert.equal(r.claimed.length, 1);
    assert.equal(r.claimed[0].hostSession, null);
    assert.ok(r.claimed[0].message.startsWith(`check test failed on PR ${URL9}, fix it.`));
    assert.match(r.claimed[0].message, /src\/a\.ts:12:5 - error TS2322/);
    assert.doesNotMatch(r.claimed[0].message, /deprecated/);
    assert.equal(readPrFiles(ws)[0].fm.notified_checks, `${SHA1}: test`);

    const again = deps([view, JOB_LOG]);
    assert.deepEqual(wakes(await claim(ws, again)), [], "nothing new, nothing sent");
    assert.ok(
      !again.calls.some((c) => c.startsWith("gh run view")),
      "an announced check is not refetched",
    );
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a failed merge-queue run wakes once with its cause; a green one doesn't (SW-454)", async () => {
  // Queue runs sit on gh-readonly-queue/<base>/pr-<N>-<sha>, never in the head's statusCheckRollup.
  const Q = "q1";
  const qrun = (id, conclusion, workflowName, headSha = Q, pr = 9) => ({
    databaseId: id,
    headBranch: `gh-readonly-queue/main/pr-${pr}-${headSha}`,
    headSha,
    conclusion,
    status: "completed",
    workflowName,
  });
  const queue = (...runs) => [
    /^gh run list .*--event merge_group/,
    { stdout: JSON.stringify([qrun(88, "failure", "CI", "q9", 10), ...runs]) },
  ];
  const RUN_LOG = [/^gh run view 7\d .*--log-failed/, { stdout: LOG }];
  const green = openView({ statusCheckRollup: [run("test", "SUCCESS")] });
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    // The newest run is a green CI; e2e on the same queue commit failed.
    const r = await claim(
      ws,
      deps([green, queue(qrun(77, "success", "CI"), qrun(76, "failure", "e2e")), RUN_LOG]),
    );
    assert.equal(r.claimed.length, 1, "the dropped queue entry wakes the session");
    assert.match(r.claimed[0].message, /^check merge queue \(e2e\) failed on PR /);
    assert.doesNotMatch(r.claimed[0].message, /merge queue \(CI\)/);
    assert.match(r.claimed[0].message, /src\/a\.ts:12:5 - error TS2322/);
    assert.equal(readPrFiles(ws)[0].fm.notified_queue, Q);
    const again = deps([
      green,
      queue(qrun(77, "success", "CI"), qrun(76, "failure", "e2e")),
      RUN_LOG,
    ]);
    assert.deepEqual(wakes(await claim(ws, again)), [], "announced once");
    assert.ok(!again.calls.some((c) => c.startsWith("gh run view")));
    const retry = await claim(ws, deps([green, queue(qrun(79, "failure", "CI", "q2")), RUN_LOG]));
    assert.equal(retry.claimed.length, 1, "a re-queued entry that fails wakes again");
  } finally {
    clean(ws);
  }
  const ok = icmWorkspace({ files: { app: openFile() } });
  try {
    const d = deps([green, queue(qrun(77, "success", "CI"), qrun(76, "success", "e2e"))]);
    assert.deepEqual(wakes(await claim(ok, d)), [], "a green queue run is no news");
    assert.ok(!d.calls.some((c) => c.startsWith("gh run view")));
  } finally {
    clean(ok);
  }
});

test("claimCallbacks: a new head announces what still fails; the same head only new names", async () => {
  const ws = icmWorkspace({ files: { app: openFile(`notified_checks: "${SHA1}: test"\n`) } });
  try {
    const head2 = {
      headRefOid: SHA2,
      statusCheckRollup: [run("test", "FAILURE"), run("lint", "TIMED_OUT", 2)],
    };
    const r = await claim(ws, deps([openView(head2)]));
    assert.match(wakes(r)[0], /check lint failed/);
    assert.match(wakes(r)[0], /check test failed/, "the fix didn't work: still news on a new head");
    assert.equal(readPrFiles(ws)[0].fm.notified_checks, `${SHA2}: lint, test`);

    const more = {
      ...head2,
      statusCheckRollup: [...head2.statusCheckRollup, run("docs", "FAILURE", 3)],
    };
    const r2 = await claim(ws, deps([openView(more)]));
    assert.equal(r2.claimed.length, 1);
    assert.doesNotMatch(wakes(r2)[0], /check (lint|test) failed/);
    assert.match(wakes(r2)[0], /check docs failed/);

    const cancelled = {
      ...more,
      statusCheckRollup: [run("e2e", "CANCELLED", 4), run("skip", "SKIPPED", 5)],
    };
    assert.deepEqual(wakes(await claim(ws, deps([openView(cancelled)]))), []);
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a changes-requested review wakes once, even after pr status recorded it", async () => {
  // `review` is pr status's key for the issue move; the wake must not depend on who saw it first.
  const ws = icmWorkspace({ files: { app: openFile("review: changes_requested\n") } });
  try {
    const view = openView({
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [
        {
          author: { login: "ann" },
          state: "CHANGES_REQUESTED",
          body: "rename it",
          submittedAt: "2026-10-31T10:00:00Z",
        },
      ],
    });
    const r = await claim(ws, deps([view]));
    assert.equal(r.claimed.length, 1);
    assert.match(
      wakes(r)[0],
      new RegExp(`^address the review on PR ${URL9}:\\n    ann: rename it`),
    );
    assert.equal(readPrFiles(ws)[0].fm.notified_review, "2026-10-31T10:00:00Z");
    assert.deepEqual(wakes(await claim(ws, deps([view]))), []);
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: inline comments are quoted with path:line; the session's own replies don't wake", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    const mine = {
      user: { login: "me" },
      body: "Done.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      path: "a.ts",
      line: 3,
      created_at: "2026-10-31T10:05:00Z",
    };
    const theirs = {
      user: { login: "ann" },
      body: "off by one",
      path: "src/a.ts",
      line: 12,
      created_at: "2026-10-31T10:00:00Z",
    };
    const r = await claim(ws, deps([openView(), INLINE([theirs, mine])]));
    assert.match(wakes(r)[0], /ann on src\/a\.ts:12: off by one/);
    assert.doesNotMatch(wakes(r)[0], /Done\./);
    const r2 = await claim(ws, deps([openView(), INLINE([theirs, mine])]));
    assert.deepEqual(wakes(r2), []);
    const onlyMine = icmWorkspace({ files: { app: openFile() } });
    try {
      assert.deepEqual(wakes(await claim(onlyMine, deps([openView(), INLINE([mine])]))), []);
    } finally {
      clean(onlyMine);
    }
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a PR opened before SW-160 takes its old comments as history", async () => {
  const ws = icmWorkspace({ files: { app: callbackFile() } });
  try {
    const view = openView({
      comments: [{ author: { login: "ann" }, body: "old", createdAt: "2026-10-01T00:00:00Z" }],
    });
    const r = await claim(ws, deps([view]));
    assert.deepEqual(wakes(r), []);
    assert.equal(readPrFiles(ws)[0].fm.notified_review, "2026-10-01T00:00:00Z");
    const newer = openView({
      comments: [{ author: { login: "ann" }, body: "new", createdAt: "2026-10-02T00:00:00Z" }],
    });
    assert.match(wakes(await claim(ws, deps([newer])))[0], /ann: new/);
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a conflict wakes once with the base commits; resolved resets it; UNKNOWN changes nothing", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    const moved = [/log --oneline -10 HEAD\.\.origin\/main/, { stdout: "abc1234 feat: moved\n" }];
    const conflicting = openView({ mergeable: "CONFLICTING" });
    const r = await claim(ws, deps([conflicting, moved]));
    assert.ok(
      wakes(r)[0].startsWith(
        `PR ${URL9} conflicts with main, resolve it.\n  Base moved:\n    abc1234 feat: moved\n`,
      ),
    );
    // SW-494: the lease names the PR file's branch and GitHub's head, the commit the person replaces.
    assert.ok(
      wakes(r)[0].includes(
        `git -C ${path.join(ws, "app")} push --force-with-lease=me/ws:${SHA1}\n`,
      ),
      wakes(r)[0],
    );
    assert.ok(wakes(r)[0].includes(`git -C ${path.join(ws, "app")} rebase origin/main`));
    assert.equal(readPrFiles(ws)[0].fm.notified_conflict, "true");
    assert.deepEqual(wakes(await claim(ws, deps([conflicting, moved]))), []);
    assert.deepEqual(wakes(await claim(ws, deps([openView({ mergeable: "UNKNOWN" })]))), []);
    assert.equal(readPrFiles(ws)[0].fm.notified_conflict, "true", "still computing: no flicker");

    assert.deepEqual(wakes(await claim(ws, deps([openView()]))), []);
    assert.ok(!("notified_conflict" in readPrFiles(ws)[0].fm), "resolved: the flag is gone");
    assert.equal(
      (await claim(ws, deps([conflicting, moved]))).claimed.length,
      1,
      "a later conflict is news",
    );
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a check, a review and a conflict in one pass are one message", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    const view = openView({
      mergeable: "CONFLICTING",
      statusCheckRollup: [run("test", "FAILURE")],
      comments: [{ author: { login: "ann" }, body: "why?", createdAt: "2026-10-31T10:00:00Z" }],
    });
    const r = await claim(ws, deps([view, JOB_LOG]));
    assert.equal(r.claimed.length, 1);
    for (const s of [
      `check test failed on PR ${URL9}, fix it.`,
      `address the review on PR ${URL9}:`,
      `PR ${URL9} conflicts with main, resolve it.`,
    ])
      assert.ok(wakes(r)[0].includes(s), s);
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a PR that merged sends the merged message, not a wake", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    const r = await claim(ws, deps([MERGED, NO_TAG]));
    assert.deepEqual(wakes(r), [callbackMessage("merged", URL9)]);
  } finally {
    clean(ws);
  }
});

// The session's hooks record, which is what makes it open rather than just recently written.
const openSession = (ws) => {
  const at = new Date().toISOString();
  fs.writeFileSync(
    path.join(dotDir(ws), "agent-state.json"),
    JSON.stringify({ state: "working", at, sessions: { "s-1": { status: "busy", at } } }),
  );
};

test("claimCallbacks: a wake for an open session is claimed and left as its nudge, never sent headless (SW-418)", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  const nudge = () =>
    JSON.parse(fs.readFileSync(path.join(dotDir(ws), "wake-nudge-s-1.json"), "utf8"));
  try {
    openSession(ws);
    const view = openView({ mergeable: "CONFLICTING" });
    const busy = await claim(ws, deps([view], { sessionBusy: async () => true }));
    assert.deepEqual(wakes(busy), [], "no headless resume into an open session");
    assert.ok(busy.lines.includes("app: wake held, session s-1 in use"), busy.lines.join("\n"));
    assert.match(nudge().message, new RegExp(`PR ${URL9} conflicts with main, resolve it.`));
    assert.deepEqual(
      heldWakes(ws).map((w) => w.session),
      ["s-1"],
      "the held wake is the card's fact",
    );
    assert.equal(readPrFiles(ws)[0].fm["notified_conflict"], "true", "claimed with the nudge");
    assert.deepEqual(wakes(await claim(ws, deps([view]))), [], "not sent again once idle");
  } finally {
    clean(ws);
  }
  const merged = icmWorkspace({ files: { app: openFile() } });
  try {
    openSession(merged);
    const held = await claim(merged, deps([MERGED, NO_TAG], { sessionBusy: async () => true }));
    assert.deepEqual(wakes(held), []);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dotDir(merged), "wake-nudge-s-1.json"), "utf8")).message,
      callbackMessage("merged", URL9),
      "a status message is nudged the same way",
    );
  } finally {
    clean(merged);
  }
});

test("claimCallbacks: a session busy only by a fresh transcript has closed: held unclaimed, woken headless once quiet", async () => {
  const ws = icmWorkspace({ files: { app: openFile() } });
  try {
    const view = openView({ statusCheckRollup: [run("test", "FAILURE")] });
    const busy = await claim(ws, deps([view, JOB_LOG], { sessionBusy: async () => true }));
    assert.deepEqual(wakes(busy), []);
    assert.ok(
      !fs.existsSync(path.join(dotDir(ws), "wake-nudge-s-1.json")),
      "no hooks to deliver it",
    );
    assert.ok(!("notified_checks" in readPrFiles(ws)[0].fm), "nothing claimed while held");
    assert.equal((await claim(ws, deps([view, JOB_LOG]))).claimed.length, 1);
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: a desktop PR's wake goes to the mod and is never held", async () => {
  const ws = icmWorkspace({ files: { app: openFile("host_session: local_h1\n") } });
  try {
    const view = openView({ statusCheckRollup: [run("test", "FAILURE")] });
    assert.deepEqual(wakes(await claim(ws, deps([view, JOB_LOG]))), [], "not the CLI pass's");
    let asked = false;
    const mod = await claim(
      ws,
      deps([view, JOB_LOG], { sessionBusy: async () => (asked = true) }),
      true,
    );
    assert.deepEqual(
      mod.claimed.map((c) => c.hostSession),
      ["local_h1"],
    );
    assert.match(wakes(mod)[0], /^check test failed/);
    assert.equal(asked, false, "the app delivers to a live session itself");
  } finally {
    clean(ws);
  }
});

test("claimCallbacks: settled drops the wake marks with the callback", async () => {
  const ws = icmWorkspace({
    files: { app: openFile(`notified_checks: "${SHA1}: test"\nnotified_conflict: "true"\n`) },
  });
  try {
    await claim(ws, deps([[/^gh pr view/, { stdout: JSON.stringify({ state: "CLOSED" }) }]]));
    const fm = readPrFiles(ws)[0].fm;
    for (const k of ["notified_checks", "notified_review", "notified_conflict", "session"])
      assert.ok(!(k in fm), k);
  } finally {
    clean(ws);
  }
});

test("watchPrs({repo}): only that repo's workspaces are claimed; an unmanaged repo is ignored (SW-583)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-watch-repo-"));
  const prev = process.env.WERKMEISTER_WORKSPACES_ROOT;
  process.env.WERKMEISTER_WORKSPACES_ROOT = root;
  fs.renameSync(icmWorkspace({ files: { app: callbackFile() } }), path.join(root, "a-ws"));
  const other = callbackFile().replace("repo: o/app", "repo: o/other").replace("s-1", "s-2");
  fs.renameSync(icmWorkspace({ files: { app: other } }), path.join(root, "b-ws"));
  fs.renameSync(icmWorkspace({ files: { app: "no frontmatter\n" } }), path.join(root, "c-broken"));
  try {
    await withSandboxHome(async () => {
      let reaped = 0;
      const d = deps([MERGED, NO_TAG]);
      d.reapIdle = async () => {
        reaped++;
        return { lines: [] };
      };
      const sent = [];
      const send = async (cb) => {
        sent.push(cb.session);
      };
      const r = await watchPrs({ desktop: false, repo: "O/App" }, d, send);
      assert.ok(r.ok);
      assert.deepEqual(sent, ["s-1"]);
      assert.equal(reaped, 0, "a pushed pass leaves reaping to the scheduled one");

      // The scheduled pass holds the lock: throw so the queue redelivers, never drop the event.
      const lock = path.join(
        path.dirname(process.env.WERKMEISTER_CONFIG_FILE),
        "pr-callbacks.lock",
      );
      fs.writeFileSync(lock, "");
      await assert.rejects(
        watchPrs({ desktop: false, repo: "o/app" }, d, send),
        /another PR watch pass is running; o\/app left for redelivery/,
      );
      assert.deepEqual(
        await watchPrs({ desktop: false }, d, send),
        {
          ok: true,
          lines: ["another PR watch pass is running"],
          desktop: [],
        },
        "the scheduled pass still just skips",
      );
      fs.rmSync(lock);
      reaped = 0;

      const ignored = await watchPrs({ desktop: false, repo: "o/unmanaged" }, d, send);
      assert.deepEqual(ignored, {
        ok: true,
        lines: ["github ingest: no workspace has a PR for o/unmanaged; ignored"],
        desktop: [],
      });
      assert.deepEqual(sent, ["s-1"]);
      assert.equal(reaped, 0);
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_WORKSPACES_ROOT;
    else process.env.WERKMEISTER_WORKSPACES_ROOT = prev;
    clean(root);
  }
});

test("watchPrs: headless claims are sent, desktop ones returned, a failed send is reported", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-watch-"));
  const prev = process.env.WERKMEISTER_WORKSPACES_ROOT;
  process.env.WERKMEISTER_WORKSPACES_ROOT = root;
  fs.renameSync(icmWorkspace({ files: { app: callbackFile() } }), path.join(root, "a-ws"));
  fs.renameSync(
    icmWorkspace({ files: { app: callbackFile("host_session: local_h1\n") } }),
    path.join(root, "b-desk"),
  );
  try {
    await withSandboxHome(async () => {
      const sent = [];
      const r = await watchPrs({ desktop: true }, deps([MERGED, NO_TAG]), async (cb) => {
        sent.push(cb.session);
      });
      assert.deepEqual(sent, ["s-1"]);
      assert.deepEqual(
        r.desktop.map((c) => c.hostSession),
        ["local_h1"],
      );

      fs.writeFileSync(
        path.join(root, "a-ws", "stages", "03_propose", "output", "pr-app.md"),
        callbackFile(),
      );
      const failed = await watchPrs({ desktop: false }, deps([MERGED, NO_TAG]), async () => {
        throw new Error("session s-1 is gone");
      });
      assert.ok(
        failed.lines.includes(`app: could not resume session s-1: session s-1 is gone`),
        failed.lines.join("\n"),
      );

      // SW-313: a turn that was refused commands says so, in the log and on the workspace card.
      fs.writeFileSync(
        path.join(root, "a-ws", "stages", "03_propose", "output", "pr-app.md"),
        callbackFile(),
      );
      const refused = async () => ["Bash: pnpm run test", "Bash: git commit -qam fix"];
      const retried = await watchPrs({ desktop: false }, deps([MERGED, NO_TAG]), refused);
      assert.ok(
        retried.lines.includes(
          "app: auto-fix: 2 calls refused and retried — Bash: pnpm run test; Bash: git commit -qam fix",
        ),
        retried.lines.join("\n"),
      );
      assert.equal(
        readNotices(path.join(root, "a-ws"))["autofix-app"],
        undefined,
        "a fix that landed",
      );

      fs.writeFileSync(
        path.join(root, "a-ws", "stages", "03_propose", "output", "pr-app.md"),
        callbackFile(),
      );
      const blocked = await watchPrs(
        { desktop: false },
        deps([MERGED, NO_TAG, [/status --porcelain$/, { stdout: " M index.js\n" }]]),
        refused,
      );
      const line =
        "auto-fix blocked: needs approval — Bash: pnpm run test; Bash: git commit -qam fix";
      assert.ok(blocked.lines.includes(`app: ${line}`), blocked.lines.join("\n"));
      const flagged = readNotices(path.join(root, "a-ws"))["autofix-app"];
      assert.ok(flagged.what.startsWith(line), flagged.what);
      fs.writeFileSync(
        path.join(root, "a-ws", "stages", "03_propose", "output", "pr-app.md"),
        callbackFile(),
      );
      await watchPrs({ desktop: false }, deps([MERGED, NO_TAG]), async () => []);
      assert.equal(
        readNotices(path.join(root, "a-ws"))["autofix-app"],
        undefined,
        "a clean resend clears it",
      );
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_WORKSPACES_ROOT;
    else process.env.WERKMEISTER_WORKSPACES_ROOT = prev;
    clean(root);
  }
});

test("deliverHeadless: a session started in a code worktree is resumed from there (SW-16)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-deliver-")));
  const prev = process.env.WERKMEISTER_WORKSPACES_ROOT;
  process.env.WERKMEISTER_WORKSPACES_ROOT = root;
  const ws = path.join(root, "a-ws");
  fs.renameSync(icmWorkspace(), ws);
  const sub = path.join(ws, "sandbox");
  fs.mkdirSync(sub);
  const cb = (session, sessionDir = null) => ({
    ws,
    dir: "app",
    url: URL9,
    session,
    sessionDir,
    hostSession: null,
    message: "merged",
  });
  // The allow and deny lists before it are the SW-313 test's.
  const resumed = (dir, id) => [
    dir,
    `--permission-mode acceptEdits --output-format json --resume ${id} merged`,
  ];
  const tail = (lines) => [
    lines.at(-2),
    lines.at(-1).slice(lines.at(-1).indexOf("--permission-mode")),
  ];
  try {
    await withSandboxHome(() =>
      withClaudeHome({ "s-sub": sub, "s-root": ws }, async (calls) => {
        assert.deepEqual(await callbackFields(ws, { CLAUDE_CODE_SESSION_ID: "s-sub" }), {
          session: "s-sub",
          session_cwd: sub,
        });

        await deliverHeadless(cb("s-sub", sub));
        assert.deepEqual(tail(await calls(2)), resumed(sub, "s-sub"));

        // Recorded before SW-16: no start folder, found by its id alone.
        await deliverHeadless(cb("s-sub"));
        assert.deepEqual(tail(await calls(4)), resumed(sub, "s-sub"));

        await deliverHeadless(cb("s-root", ws));
        assert.deepEqual(tail(await calls(6)), resumed(ws, "s-root"));

        // Never another session: not the root's newest, not a wrong recorded folder.
        await assert.rejects(deliverHeadless(cb("s-gone")), /session s-gone is gone/);
        await assert.rejects(deliverHeadless(cb("s-sub", ws)), /session s-sub is gone/);
        assert.equal((await calls()).length, 6);
      }),
    );
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_WORKSPACES_ROOT;
    else process.env.WERKMEISTER_WORKSPACES_ROOT = prev;
    clean(root);
  }
});

test("deliverHeadless: a codex session started in a code worktree is resumed from there (SW-489)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-deliver-")));
  const env = { ...process.env };
  process.env.WERKMEISTER_WORKSPACES_ROOT = root;
  process.env.CODEX_HOME = path.join(root, "codex");
  const ws = path.join(root, "a-ws");
  fs.renameSync(icmWorkspace(), ws);
  fs.appendFileSync(path.join(dotDir(ws), "workspace.yml"), "harness: codex\n");
  const sub = path.join(ws, "sandbox");
  fs.mkdirSync(sub);
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "05");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, "rollout-2026-11-05T10-00-00-c-sub.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "c-sub", cwd: sub } })}\n`,
  );
  const log = path.join(root, "codex.log");
  process.env.CODEX_BIN = path.join(root, "codex-bin");
  fs.writeFileSync(process.env.CODEX_BIN, `#!/bin/sh\n{ pwd -P; echo "$@"; } >> "${log}"\n`, {
    mode: 0o755,
  });
  try {
    await withSandboxHome(async () => {
      assert.deepEqual(await callbackFields(ws, {}), { session: "c-sub", session_cwd: sub });
      // Recorded before SW-489: no start folder, found by its id alone.
      await deliverHeadless({
        ws,
        dir: "app",
        url: URL9,
        session: "c-sub",
        sessionDir: null,
        hostSession: null,
        message: "merged",
      });
      for (const end = Date.now() + 30_000; !fs.existsSync(log) && Date.now() < end; )
        await sleep(50);
      assert.equal(fs.readFileSync(log, "utf8").split("\n")[0], sub);
    });
  } finally {
    for (const k of ["WERKMEISTER_WORKSPACES_ROOT", "CODEX_HOME", "CODEX_BIN"])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    clean(root);
  }
});

test("deliverHeadless: the wake can commit, push and read checks in a non-autonomous workspace (SW-313)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-deliver-")));
  const prev = process.env.WERKMEISTER_WORKSPACES_ROOT;
  process.env.WERKMEISTER_WORKSPACES_ROOT = root;
  const ws = path.join(root, "a-ws");
  fs.renameSync(icmWorkspace(), ws);
  const cb = {
    ws,
    dir: "app",
    url: URL9,
    session: "s-root",
    sessionDir: ws,
    hostSession: null,
    message: `check test failed on PR ${URL9}, fix it.`,
  };
  try {
    await withSandboxHome(() =>
      withClaudeHome({ "s-root": ws }, async (calls) => {
        await deliverHeadless(cb);
        const argv = (await calls(2)).at(-1);
        // Without these the turn edits files, then every commit, push and check read is refused.
        // SW-560: it tests only through a registered test command, and this fixture registers none.
        for (const rule of ["Bash(git:*)", "Bash(gh pr checks:*)"])
          assert.ok(argv.includes(rule), `wake argv lacks ${rule}: ${argv}`);
        assert.ok(argv.includes("--disallowedTools"), "AUTONOMOUS_DENY still applies");
      }),
    );
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_WORKSPACES_ROOT;
    else process.env.WERKMEISTER_WORKSPACES_ROOT = prev;
    clean(root);
  }
});

test("sessionBusy: an open terminal session is busy even when idle at its prompt (SW-313)", async () => {
  const ws = icmWorkspace();
  try {
    await withSandboxHome(async () => {
      const at = new Date().toISOString();
      fs.writeFileSync(
        path.join(dotDir(ws), "agent-state.json"),
        JSON.stringify({ state: "done", at, sessions: { "s-open": { status: "idle", at } } }),
      );
      const { sessionBusy } = defaultDeps();
      assert.equal(await sessionBusy(ws, "s-open", ws), true);
      assert.equal(await sessionBusy(ws, "s-closed", ws), false);
    });
  } finally {
    clean(ws);
  }
});

test("watchPrs: one idle-reaper pass under its own lock; a held lock skips it (SW-39)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-watch-idle-"));
  const prev = process.env.WERKMEISTER_WORKSPACES_ROOT;
  process.env.WERKMEISTER_WORKSPACES_ROOT = root;
  const lock = path.join(root, "idle-stop.lock");
  try {
    await withSandboxHome(async () => {
      let passes = 0;
      const d = deps([], {
        reapIdle: async () => {
          passes++;
          return { lines: ["demo: stopped (idle ≥ 30 min)"] };
        },
      });
      const r = await watchPrs({ desktop: false }, d, async () => {}, lock);
      assert.equal(passes, 1);
      assert.ok(r.lines.includes("demo: stopped (idle ≥ 30 min)"), r.lines.join("\n"));
      assert.ok(!fs.existsSync(lock), "released after the pass");

      fs.writeFileSync(lock, "");
      const held = await watchPrs({ desktop: true }, d, async () => {}, lock);
      assert.equal(passes, 1);
      assert.ok(held.lines.includes("another idle-stop pass is running"));
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_WORKSPACES_ROOT;
    else process.env.WERKMEISTER_WORKSPACES_ROOT = prev;
    clean(root);
  }
});

// ---- SW-103: more than one PR file per worktree --------------------------------

/** A follow-up PR file for worktree `app`, named `pr-app-<slug>.md`. */
const followUp = (status, extra = "") =>
  prFile({ status, extra: `worktree: app\n${extra}` }).replace(
    "branch: me/ws\n",
    "branch: me/ws-fix\n",
  );

test("PR file identity: worktree from frontmatter, the file name as fallback (SW-103)", () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped" }), "app-fix": followUp("draft") },
  });
  try {
    const got = readPrFiles(ws).map((f) => [f.stem, f.dir]);
    assert.deepEqual(got, [
      ["app-fix", "app"],
      ["app", "app"],
    ]);
  } finally {
    clean(ws);
  }
});

test("lifecycleOf: two PR files for one worktree in each state (SW-103)", () => {
  const cases = [
    ["shipped", "draft", "working"],
    ["shipped", "approved", "working"],
    ["shipped", "open", "pr-open"],
    ["shipped", "merged", "merged"],
    ["shipped", "shipped", "shipped"],
    ["merged", "open", "pr-open"],
    ["shipped", "closed", "shipped"],
    ["shipped", "abandoned", "shipped"],
  ];
  for (const [first, second, want] of cases) {
    const ws = icmWorkspace({
      files: { app: prFile({ status: first }), "app-fix": followUp(second) },
    });
    try {
      assert.equal(lifecycleOf(ws).state, want, `${first} + ${second}`);
    } finally {
      clean(ws);
    }
  }
});

test("newPr: cuts <branch>-<slug> from base and writes a draft follow-up (SW-103)", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "shipped" }) } });
  try {
    let recorded = null;
    const d = deps([], {
      commitRecord: async (_ws, _m, paths) => {
        recorded = paths;
        return { ok: true, message: "record pushed" };
      },
    });
    const r = await newPr(ws, "app", "fix", d);
    assert.ok(r.ok);
    const wt = path.join(ws, "app");
    assert.ok(d.calls.includes(`git -C ${wt} fetch -q origin main`));
    assert.ok(d.calls.includes(`git -C ${wt} switch --no-track -c me/ws-fix origin/main`));
    const f = readPrFiles(ws).find((x) => x.stem === "app-fix");
    assert.equal(f.dir, "app");
    assert.deepEqual(
      [f.fm.worktree, f.fm.repo, f.fm.branch, f.fm.base, f.fm.status],
      ["app", "o/app", "me/ws-fix", "main", "draft"],
    );
    assert.deepEqual(recorded, ["stages/03_propose/output/pr-app-fix.md"]);
    assert.match(
      r.lines[0],
      /^app-fix: draft .*pr-app-fix\.md on me\/ws-fix \(from origin\/main\)$/,
    );
  } finally {
    clean(ws);
  }
});

test("newPr: refuses while the worktree's branch is in use, and on bad input (SW-103)", async () => {
  const refused = async (files, args, re, table = []) => {
    const ws = icmWorkspace({ files });
    try {
      const d = deps(table);
      await assert.rejects(newPr(ws, ...args, d), re);
      assert.ok(!d.calls.some((c) => c.includes(" switch ")), "no branch is cut");
    } finally {
      clean(ws);
    }
  };
  const shipped = { app: prFile({ status: "shipped" }) };
  for (const status of ["open", "approved", "draft"])
    await refused(
      { ...shipped, "app-one": followUp(status) },
      ["app", "two"],
      new RegExp(`app still has app-one \\(${status}\\)`),
    );
  await refused({ lib: prFile({ status: "shipped" }) }, ["app", "fix"], /No PR file for app yet/);
  await refused({ ...shipped, "app-fix": followUp("shipped") }, ["app", "fix"], /already exists/);
  await refused(shipped, ["app", "Fix_1"], /--slug/);
  await refused(shipped, ["app", "fix"], /app has uncommitted changes/, [
    [/status --porcelain/, { stdout: " M x.ts\n" }],
  ]);
});

test("newPr: a refusal over an open or approved PR file says it may be stale and to run pr status (SW-112)", async () => {
  const hint = /If it has merged, run werkmeister pr status first to record it\./;
  for (const status of ["open", "approved"]) {
    const ws = icmWorkspace({ files: { app: prFile({ status }) } });
    try {
      await assert.rejects(newPr(ws, "app", "fix", deps([])), hint, status);
    } finally {
      clean(ws);
    }
  }
  // A draft has no PR yet, so there is nothing to have merged.
  const ws = icmWorkspace({ files: { app: prFile({ status: "draft" }) } });
  try {
    await assert.rejects(newPr(ws, "app", "fix", deps([])), (e) => !hint.test(e.message));
  } finally {
    clean(ws);
  }
});

test("gatePrs: a superseded PR file is skipped; a worktree or a file name selects (SW-103)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped" }), "app-fix": followUp("approved") },
  });
  try {
    for (const only of [undefined, "app", "app-fix"]) {
      const r = await withSandboxHome(() => gatePrs(ws, only, deps([DIFF_API])));
      assert.ok(r.ok, `${only}: ${r.lines.join("\n")}`);
      assert.equal(r.lines[0], "app-fix: gate passed");
    }
    await assert.rejects(
      withSandboxHome(() => gatePrs(ws, "app-nope", deps([]))),
      /No PR file for app-nope in/,
    );
  } finally {
    clean(ws);
  }
});

test("openPrs: opens the follow-up only; a Done issue gets a comment, not a move (SW-103)", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "shipped", extra: "url: https://github.com/o/app/pull/8\n" }),
      "app-fix": followUp("approved"),
    },
  });
  try {
    const tracker = issueAt("Closed");
    const d = deps([DIFF_API, [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }]], {
      tracker,
    });
    const r = await open(ws, d);
    assert.ok(r.ok, r.lines.join("\n"));
    assert.ok(
      r.lines.includes("app-fix: open https://github.com/o/app/pull/9"),
      r.lines.join("\n"),
    );
    const pushes = d.calls.filter((c) => / push -u origin /.test(c));
    assert.deepEqual(
      pushes.map((c) => c.split(" ").at(-1)),
      ["me/ws-fix"],
    );
    const byStem = Object.fromEntries(readPrFiles(ws).map((f) => [f.stem, f.fm]));
    assert.equal(byStem["app-fix"].status, "open");
    assert.equal(byStem.app.status, "shipped");
    assert.deepEqual(tracker.updates, [
      ["o/app#7", undefined, "Follow-up PR opened: https://github.com/o/app/pull/9"],
    ]);
  } finally {
    clean(ws);
  }
});

test("openPrs: refuses a branch an earlier PR of the worktree already used (SW-103)", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "merged" }),
      "app-fix": prFile({ status: "approved", extra: "worktree: app\n" }),
    },
  });
  try {
    const d = deps([DIFF_API]);
    const r = await open(ws, d);
    assert.equal(r.ok, false);
    assert.match(
      r.lines[0],
      /^app-fix: branch me\/ws was already used by app \(merged\) — .*pr new app/,
    );
    assert.ok(!d.calls.some((c) => / push /.test(c)));
  } finally {
    clean(ws);
  }
  // Two repos of one workspace share a branch name; that is not reuse.
  const multi = icmWorkspace({
    files: { lib: prFile({ status: "shipped" }), app: prFile({ status: "approved" }) },
  });
  try {
    const d = deps([DIFF_API, [/^gh pr create/, { stdout: "https://github.com/o/app/pull/9\n" }]]);
    const r = await open(multi, d);
    assert.ok(r.ok, r.lines.join("\n"));
  } finally {
    clean(multi);
  }
});

test("refreshPrStatus: each PR file of a worktree ships on its own; done once both settle (SW-103)", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "merged", extra: "url: https://x/pr/8\nmerge_sha: aaa\n" }),
      "app-fix": followUp("open", "url: https://x/pr/9\n"),
    },
  });
  try {
    const tracker = issueAt("Open", ["Peer Review"]);
    await refreshPrStatus(
      ws,
      deps([[/^gh pr view https:\/\/x\/pr\/9 /, { stdout: JSON.stringify({ state: "OPEN" }) }]], {
        tracker,
      }),
    );
    let byStem = Object.fromEntries(readPrFiles(ws).map((f) => [f.stem, f.fm.status]));
    assert.deepEqual(byStem, { "app-fix": "open", app: "merged" });
    await refreshPrStatus(
      ws,
      deps(
        [
          [
            /^gh pr view https:\/\/x\/pr\/9 /,
            { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "bbb" } }) },
          ],
          [/tag --contains (aaa|bbb)/, { stdout: "v1.3.0\n" }],
        ],
        { tracker },
      ),
    );
    byStem = Object.fromEntries(readPrFiles(ws).map((f) => [f.stem, f.fm.status]));
    assert.deepEqual(byStem, { "app-fix": "shipped", app: "shipped" });
    assert.equal(lifecycleOf(ws).state, "shipped");
    assert.equal(tracker.updates.filter((u) => u[1] === "closed").length, 1);
  } finally {
    clean(ws);
  }
});

test("adoptPr: a second PR for a worktree is written as pr-<repo>-<number>.md (SW-103)", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: https://github.com/o/app/pull/8\n" }) },
  });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    const view = {
      url: "https://github.com/o/app/pull/141",
      headRefName: "other/fix",
      baseRefName: "main",
      title: "fix: after release",
      state: "OPEN",
    };
    const d = deps([
      [/^gh pr view 141 /, { stdout: JSON.stringify(view) }],
      [/^gh pr view https/, { stdout: JSON.stringify({ state: "OPEN" }) }],
    ]);
    const r = await adoptPr(ws, { pr: "141" }, d);
    assert.equal(r.lines[0], "app-141: adopted as open");
    const f = readPrFiles(ws).find((x) => x.stem === "app-141");
    assert.equal(f.dir, "app");
    assert.equal(f.fm.url, view.url);
    await assert.rejects(adoptPr(ws, { pr: "141" }, d), /already tracked in pr-app-141\.md/);
  } finally {
    clean(ws);
  }
});

test("removalBlockers: every PR file of a worktree counts (SW-103)", async () => {
  const trees = [{ repo: "app", dir: "/w/app" }];
  const { run } = stubRun([[/rev-list --count origin\/main\.\.HEAD/, { stdout: "1\n" }]]);
  const blockers = async (second) => {
    const ws = icmWorkspace({
      files: { app: prFile({ status: "shipped" }), "app-fix": followUp(second, "url: u\n") },
    });
    try {
      return await removalBlockers(ws, trees, run);
    } finally {
      clean(ws);
    }
  };
  assert.deepEqual(await blockers("open"), ["app: PR is open (u)"]);
  assert.deepEqual(await blockers("shipped"), []);
  assert.deepEqual(await blockers("draft"), [
    "app: 1 commit(s) not on origin/main and no merged PR",
  ]);
});

test("gate: prints a containers row when a running container is kept (SW-355, SW-362)", async () => {
  const ws = icmWorkspace();
  try {
    const running = deps([DIFF_API]);
    const g = await gate(ws, running);
    assert.deepEqual(running.started, ["feat-api"]);
    const row = g.checks.find((c) => c.name === "containers");
    assert.equal(row.ok, true);
    assert.equal(
      row.detail,
      "kept (feat-api already running, setup one-shot re-run unless current)",
    );

    // Nothing running: the started-and-stopped row stays, and no kept row.
    const none = deps([DIFF_API]);
    none.run = stubRun([[/^docker ps/, { stdout: "" }], DIFF_API]).run;
    const g2 = await gate(ws, none);
    const rows = g2.checks.filter((c) => c.name === "containers").map((c) => c.detail);
    assert.ok(
      rows.every((d) => !d.startsWith("kept")),
      rows.join("\n"),
    );
    assert.ok(
      rows.some((d) => /^started feat-api.* for the gate, stopped again$/.test(d)),
      rows.join("\n"),
    );
  } finally {
    clean(ws);
  }
});

test("waitForHostLoadNow: WERKMEISTER_NO_WAIT=1 skips the wait as --no-wait does (SW-425)", async () => {
  const falls = loaded([90, 1]);
  process.env.WERKMEISTER_NO_WAIT = "1";
  try {
    assert.equal(await withSandboxHome(() => waitForHostLoadNow(falls, "linux")), "");
  } finally {
    delete process.env.WERKMEISTER_NO_WAIT;
  }
  assert.deepEqual(falls.slept, []);
});

// SW-500: In Review at `pr open` and Done at ship cover the lead and each `group:` member.
test("a grouped workspace's In Review and Done moves cover each member (SW-500)", async () => {
  const group = (ws) =>
    fs.appendFileSync(path.join(dotDir(ws), "workspace.yml"), "group:\n  - o/app#8\n  - o/app#9\n");
  const refs = ["o/app#7", "o/app#8", "o/app#9"];

  const opened = icmWorkspace();
  group(opened);
  try {
    const tracker = issueAt("Open");
    const url = "https://github.com/o/app/pull/9";
    const r = await open(
      opened,
      deps([DIFF_API, [/^gh pr create/, { stdout: `${url}\n` }]], { tracker }),
    );
    assert.ok(r.ok, r.lines.join("\n"));
    assert.deepEqual(
      tracker.updates,
      refs.map((ref) => [ref, "Peer Review", `PR opened: ${url}`]),
    );
  } finally {
    clean(opened);
  }

  const shipped = icmWorkspace({
    files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) },
  });
  group(shipped);
  try {
    const tracker = issueAt("Open", ["Peer Review"]);
    await refreshPrStatus(
      shipped,
      deps(
        [
          prView({ state: "MERGED", mergeCommit: { oid: "abc" } }),
          [/tag --contains abc/, { stdout: "v1.2.0\n" }],
        ],
        { tracker },
      ),
    );
    assert.deepEqual(
      tracker.updates,
      refs.map((ref) => [ref, "closed", "Shipped: v1.2.0 — https://x/pr/9"]),
    );
  } finally {
    clean(shipped);
  }

  const closing = icmWorkspace({
    files: { app: prFile({ status: "shipped", extra: "url: https://x/pr/9\nmerge_sha: abc\n" }) },
  });
  group(closing);
  try {
    const tracker = issueAt("Open", ["Peer Review"]);
    const r = await inWorkspacesRoot(closing, (name) =>
      closeOut(name, {}, deps([[/ls-remote/, { code: 2 }]], { tracker })),
    );
    assert.deepEqual(
      tracker.updates.map(([ref, status]) => [ref, status]),
      refs.map((ref) => [ref, "closed"]),
    );
    assert.match(r.output, /o\/app#7 → closed; o\/app#8 → closed; o\/app#9 → closed/);
  } finally {
    clean(closing);
  }
});
