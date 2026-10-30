// The workspace PR lifecycle (docs/workspace-lifecycle.md). PR files, the gate's
// decisions, lifecycle state and close-out ordering are real; git, gh, docker,
// HTTP and the issue tracker are stubbed at the `deps` seam.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { dotDir } from "./dist/config.js";
import { resolveIssueStatuses } from "./dist/issue_status.js";
import {
  abandonWorkspace,
  adoptPr,
  callbackFields,
  callbackMessage,
  claimCallbacks,
  closeOut,
  deliverHeadless,
  formatGate,
  gatePrs,
  lifecycleOf,
  mapTouched,
  newPr,
  openPrs,
  openTerminalSessions,
  prFileDir,
  readPrFiles,
  refreshPrStatus,
  removalBlockers,
  runGate,
  watchPrs,
  writePrFields,
} from "./dist/pr_lifecycle.js";
import { removeWorkspace, WorkspaceError } from "./dist/sandbox.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

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
  const run = async (bin, args) => {
    const line = [bin, ...args].join(" ");
    calls.push(line);
    for (const [re, res] of table)
      if (re.test(line)) return { stdout: "", stderr: "", code: 0, ...res };
    // The origin the PR file's `repo: o/app` must match (SW-194).
    const origin = /remote get-url origin$/.test(line) ? "git@github.com:o/app.git\n" : "";
    return { stdout: origin, stderr: "", code: 0 };
  };
  return { run, calls };
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
    branchRegistry: () => null,
    stop: async (ws) => {
      stopped.push(ws);
      return "containers stopped";
    },
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
  } finally {
    clean(ws);
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

/** Exercise evidence missing from a stage that has other output, so the stages check passes. */
function noExercise(opts = {}) {
  const ws = icmWorkspace({ exercise: null, ...opts });
  fs.writeFileSync(path.join(ws, "stages", "02_implement", "output", "fix.md"), "x");
  return ws;
}

test("gate fails on missing exercise evidence", async () => {
  const ws = noExercise();
  try {
    assert.deepEqual(failed(await gate(ws, deps([DIFF_API]))), ["exercise"]);
  } finally {
    clean(ws);
  }
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
    assert.deepEqual(failed(g), ["start lib", "test api"]);
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

test("gate starts one idle container for a repo with none, tests through it, then stops it (SW-34)", async () => {
  const ws = icmWorkspace();
  try {
    const d = noServices(ws);
    const g = await gate(ws, d);
    assert.deepEqual(failed(g), []);
    assert.deepEqual(d.started, ["feat-lib"], "the idle lib, not the touched api's server");
    assert.ok(d.calls.includes("docker exec feat-lib sh -c npm test -w api"), d.calls.join("\n"));
    assert.ok(d.calls.includes("docker exec feat-lib sh -c npx changeset status"));
    assert.equal(d.calls.at(-1), "docker stop feat-lib");
    assert.match(g.checks.find((c) => c.name === "containers").detail, /started feat-lib/);
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
    assert.equal(d.calls.at(-1), "docker stop feat-lib");
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

test("gate: starts and stops nothing when the repo's containers already run (SW-34)", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps([DIFF_API]);
    const g = await gate(ws, d);
    assert.deepEqual(d.started, []);
    assert.ok(!d.calls.some((c) => c.startsWith("docker stop")));
    assert.ok(!g.checks.some((c) => c.name === "containers"));
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
    assert.deepEqual(running.started, []);
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
    const g = await gate(ws, libOnly);
    assert.deepEqual(failed(g), ["baseline api"]);
    assert.deepEqual(libOnly.started, [], "a running sibling serves the tests");
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

test("gate: dirty worktree, failing test, down health endpoint", async () => {
  const ws = icmWorkspace();
  try {
    const d = deps(
      [
        DIFF_API,
        [/status --porcelain/, { stdout: " M x.ts\n" }],
        [/npm test -w api/, { code: 1, stdout: "1 failing" }],
      ],
      {
        httpStatus: async () => 502,
      },
    );
    assert.deepEqual(failed(await gate(ws, d)), ["clean", "test api", "baseline api"]);
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
    assert.equal(
      r.lines.filter((l) => l === "<pr-created>https://github.com/o/app/pull/9</pr-created>")
        .length,
      1,
      "one marker per opened PR, so the desktop app counts the session as the opener (SW-145)",
    );
    assert.deepEqual(
      updated,
      ["o/app#7", "Peer Review", "PR opened: https://github.com/o/app/pull/9"],
      "the status comes from issue_review_status, the comment names the PR",
    );
    assert.deepEqual(
      recorded,
      ["stages/03_propose/output/pr-app.md"],
      "the record commit names only the PR file",
    );
    assert.ok(d.calls.some((c) => c.startsWith("git -C") && c.endsWith("push -u origin me/ws")));
    assert.deepEqual(d.stopped, [ws], "containers stop once the PR is open (SW-39)");
    assert.equal(r.lines.at(-1), "containers stopped");
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
    assert.ok(!r.lines.some((l) => l.includes("<pr-created>")), "no PR opened, no marker");
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
    const host = loaded([1, 90]);
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

test("runGate: over the load limit it waits, then runs and says how long (SW-209)", async () => {
  const ws = icmWorkspace();
  try {
    const host = loaded([90, 90, 1]);
    const d = deps([DIFF_API], host);
    const g = await gate(ws, d);
    assert.deepEqual(host.slept.slice(0, 2), [15000, 15000]);
    assert.ok(
      d.calls.some((c) => /^docker exec .* npm test -w api/.test(c)),
      d.calls.join("\n"),
    );
    assert.equal(testRow(g).ok, true);
    assert.match(testRow(g).detail, /waited 30 s for host load/);
    assert.doesNotMatch(testRow(g).detail, /host load \d/, "a passing row gets no load line");
  } finally {
    clean(ws);
  }
});

test("runGate: still over after 30 min it runs anyway and says so (SW-209)", async () => {
  const ws = icmWorkspace();
  try {
    const host = loaded([90]);
    const d = deps([DIFF_API], host);
    const g = await gate(ws, d);
    // 120 polls of 15 s for each check that runs (test, then release).
    assert.ok(host.slept.length >= 120 && host.slept.length % 120 === 0, `${host.slept.length}`);
    assert.ok(
      d.calls.some((c) => /^docker exec .* npm test -w api/.test(c)),
      d.calls.join("\n"),
    );
    assert.equal(testRow(g).ok, true, "load never decides pass or fail");
    assert.match(testRow(g).detail, /ran with host load 90\.0 over 8 after a 30 min wait/);
  } finally {
    clean(ws);
  }
});

test("runGate: --no-wait and host_load: 0 never sleep (SW-209)", async () => {
  const ws = icmWorkspace();
  try {
    const noWait = loaded([90]);
    await withSandboxHome(() =>
      runGate(ws, readPrFiles(ws)[0], deps([DIFF_API], noWait), { wait: false }),
    );
    assert.deepEqual(noWait.slept, []);
    const off = loaded([90]);
    await withSandboxHome(() => runGate(ws, readPrFiles(ws)[0], deps([DIFF_API], off)), {
      config: "budget:\n  host_load: 0\n",
    });
    assert.deepEqual(off.slept, []);
  } finally {
    clean(ws);
  }
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
    assert.match(err.message, /--abandon/);
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
    assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
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
    assert.match(String(err), /no postmortem\.md.*--abandon "<reason>" --skip-postmortem/);
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
    assert.match(r.command, /--abandon$/);
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
    await withTranscripts(ws, TRANSCRIPTS, () =>
      inWorkspacesRoot(ws, (name) => closeOut(name, {}, d)),
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
    const r = await withTranscripts(ws, {}, () =>
      inWorkspacesRoot(ws, (name) => closeOut(name, { abandon: "superseded" }, d)),
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
    await withTranscripts(ws, TRANSCRIPTS, async (write) => {
      await assert.rejects(
        inWorkspacesRoot(ws, (name) => closeOut(name, {}, failing)),
        /Handoff failed/,
      );
      const first = fs.readFileSync(path.join(ws, "usage.json"), "utf8");
      const firstMd = fs.readFileSync(path.join(ws, "usage.md"), "utf8");
      write({ s3: [turn("2026-10-30T12:00:00.000Z", "claude-sonnet-5", { output_tokens: 1 })] });
      await inWorkspacesRoot(ws, (name) => closeOut(name, {}, deps([[/ls-remote/, { code: 2 }]])));
      assert.equal(fs.readFileSync(path.join(ws, "usage.json"), "utf8"), first);
      assert.equal(fs.readFileSync(path.join(ws, "usage.md"), "utf8"), firstMd);
      assert.match(
        fs.readFileSync(path.join(ws, "closeout.md"), "utf8"),
        /^Usage: .* across 2 sessions; see usage\.md$/m,
      );
    });
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
    "  11 ttys001  /usr/local/bin/claude\n  12 ??       claude\n  13 ttys002  claude\n  14 ttys003  zsh\n  15 ttys004  claude\n";
  const lsof = "p11\nfcwd\nn/ws/a/repo\np13\nfcwd\nn/ws/ab\np15\nfcwd\nn/ws/a\n";
  const r = stubRun([
    [/^ps /, { stdout: ps }],
    [/^lsof /, { stdout: lsof, code: 1 }],
  ]);
  const out = await openTerminalSessions("/ws/a", r.run);
  assert.deepEqual(out, [
    "terminal session: pid 11 on ttys001 in /ws/a/repo — /exit it",
    "terminal session: pid 15 on ttys004 in /ws/a — /exit it",
  ]);
  assert.ok(r.calls.includes("lsof -a -d cwd -Fpn -p 11,13,15"));
  assert.deepEqual(await openTerminalSessions("/ws/a", stubRun([[/^ps /, { code: 1 }]]).run), []);
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
const onlyReads = (calls) => calls.every((c) => /^(gh pr view|git -C \S+ (fetch|tag) )/.test(c));

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
    assert.deepEqual(recorded, ["stages/02_findings/output/pr-app.md"]);
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
    `PR ${URL9} shipped in v1.2.0. Ask the person whether to run \`werkmeister close-out\`.`,
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
  const resumed = (dir, id) => [dir, `-p --permission-mode acceptEdits --resume ${id} merged`];
  try {
    await withSandboxHome(() =>
      withClaudeHome({ "s-sub": sub, "s-root": ws }, async (calls) => {
        assert.deepEqual(await callbackFields(ws, { CLAUDE_CODE_SESSION_ID: "s-sub" }), {
          session: "s-sub",
          session_cwd: sub,
        });

        await deliverHeadless(cb("s-sub", sub));
        assert.deepEqual((await calls(2)).slice(-2), resumed(sub, "s-sub"));

        // Recorded before SW-16: no start folder, found by its id alone.
        await deliverHeadless(cb("s-sub"));
        assert.deepEqual((await calls(4)).slice(-2), resumed(sub, "s-sub"));

        await deliverHeadless(cb("s-root", ws));
        assert.deepEqual((await calls(6)).slice(-2), resumed(ws, "s-root"));

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
