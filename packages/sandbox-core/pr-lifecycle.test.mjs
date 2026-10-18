// The workspace PR lifecycle (docs/workspace-lifecycle.md). PR files, the gate's
// decisions, lifecycle state and close-out ordering are real; git, gh, docker,
// HTTP and the issue tracker are stubbed at the `deps` seam.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/config.js";
import {
  abandonWorkspace,
  adoptPr,
  callbackFields,
  callbackMessage,
  claimCallbacks,
  closeOut,
  lifecycleOf,
  mapTouched,
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
import { withSandboxHome } from "./fixtures.mjs";

const PASS_BODY = "## Acceptance\n| criterion | result |\n|---|---|\n| works | PASS |\n";

function prFile({ status = "approved", body = PASS_BODY, extra = "" } = {}) {
  return `---\nrepo: o/app\nbranch: me/ws\nbase: main\nstatus: ${status}\n${extra}---\n# feat: the title\n\n${body}`;
}

/** A temp ICM workspace: stages 01_research (done), 02_implement (exercise.md), 03_propose. */
function icmWorkspace({
  files = { app: prFile() },
  exercise = "| smoke | PASS |\n",
  researchDone = true,
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
    return { stdout: "", stderr: "", code: 0 };
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
  return {
    calls: r.calls,
    run: r.run,
    httpStatus: async () => 200,
    services: REGISTRY.services,
    archetypes: {},
    repos: REGISTRY.repos,
    tracker: {
      fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
      updateIssue: async () => {},
    },
    reviewStatus: "Peer Review",
    doneStatus: "closed",
    commitRecord: async () => ({ ok: true, message: "record pushed" }),
    remove: async () => ({ output: "removed" }),
    terminals: async () => [],
    sourceOf: async () => "/src/app",
    session: async () => ({}),
    ...over,
  };
}

const clean = (ws) => fs.rmSync(ws, { recursive: true, force: true });
// The baseline check reads ports.yaml for host ports; CI has no ~/.sandbox.
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

test("prFileDir: propose, legacy ship, JIT notes, spike has none", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-dir-"));
  try {
    assert.equal(prFileDir(ws), path.join(dotDir(ws), "notes"));
    fs.mkdirSync(path.join(ws, "stages", "01_questions"), { recursive: true });
    assert.equal(prFileDir(ws), null);
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

test("gate fails on an unfinished stage, a FAIL row and missing exercise evidence", async () => {
  const ws = icmWorkspace({
    researchDone: false,
    exercise: null,
    files: { app: prFile({ body: "| x | FAIL |\n" }) },
  });
  try {
    const g = await gate(ws, deps([DIFF_API]));
    assert.deepEqual(failed(g), ["stages", "acceptance", "exercise"]);
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

test("gate: a touched service with a test command but no container fails unless skip_tests gives a reason", async () => {
  // #145: the workspace runs other services (k8s), so this repo has no container.
  const noContainers = (ws) => {
    fs.writeFileSync(
      path.join(dotDir(ws), "workspace.yml"),
      "feature: feat\nservices: backend,frontend\nissue_id: o/app#7\nwork_type: feature\n",
    );
    const d = deps([]);
    d.run = stubRun([[/^docker ps/, { stdout: "" }], DIFF_API]).run;
    return d;
  };
  const ws = icmWorkspace({
    files: { app: prFile({ extra: "skip_release: changeset committed, checked on host\n" }) },
  });
  try {
    const g = await gate(ws, noContainers(ws));
    assert.deepEqual(failed(g), ["test api"]);
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
    const g = await gate(skipped, noContainers(skipped));
    assert.deepEqual(failed(g), []);
    assert.match(g.checks.find((c) => c.name === "test api").detail, /skipped: ran on host/);
  } finally {
    clean(skipped);
  }
});

test("gate: dirty worktree, failing test, down health endpoint, unapproved", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "draft" }) } });
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
    assert.deepEqual(failed(await gate(ws, d)), ["clean", "test api", "baseline api", "approved"]);
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
        fetchIssue: async () => null,
        updateIssue: async (ref, u) => (updated = [ref, u.status]),
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
    assert.deepEqual(
      updated,
      ["o/app#7", "Peer Review"],
      "the status comes from issue_review_status",
    );
    assert.deepEqual(
      recorded,
      ["stages/03_propose/output/pr-app.md"],
      "the record commit names only the PR file",
    );
    assert.ok(d.calls.some((c) => c.startsWith("git -C") && c.endsWith("push -u origin me/ws")));
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
  } finally {
    clean(bad);
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
    await refreshPrStatus(ws, deps([merged, [/tag --contains abc123 --list v\*/, { stdout: "" }]]));
    assert.equal(readPrFiles(ws)[0].fm.status, "merged");
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

test("closeOut --abandon: records why, leaves the issue, removes, keeps every branch, lists terminals", async () => {
  const ws = icmWorkspace({
    files: {
      app: prFile({ status: "open", extra: "url: u\n" }),
      lib: prFile({ status: "shipped", extra: "url: https://x/pr/3\n" }),
    },
  });
  try {
    let updated = false;
    const d = deps([], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async () => (updated = true),
      },
      terminals: async (dir) => [`terminal session: pid 9 on ttys001 in ${dir} — /exit it`],
    });
    const r = await inWorkspacesRoot(ws, (name) =>
      closeOut(name, { abandon: "superseded by #170" }, d),
    );
    const closeout = fs.readFileSync(path.join(ws, "closeout.md"), "utf8");
    assert.match(closeout, /Abandoned: superseded by #170/);
    assert.match(closeout, /left OPEN \(abandoned\)/);
    assert.equal(updated, false);
    assert.ok(
      !d.calls.some((c) => c.includes("branch -D") || c.includes("--delete")),
      "abandon keeps every branch",
    );
    assert.match(r.output, /removed/);
    assert.deepEqual(r.terminals, [`terminal session: pid 9 on ttys001 in ${ws} — /exit it`]);
    assert.equal(r.path, ws);
    assert.match(r.command, /--abandon$/);
  } finally {
    clean(ws);
  }
});

test("closeOut retry after an abandon that failed to remove: still abandoned", async () => {
  const ws = icmWorkspace({
    files: { app: prFile({ status: "abandoned", extra: "reason: gone\nurl: u\n" }) },
  });
  fs.writeFileSync(path.join(ws, "closeout.md"), "# Close-out\n");
  try {
    let updated = false;
    const d = deps([], {
      tracker: {
        fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }),
        updateIssue: async () => (updated = true),
      },
    });
    await inWorkspacesRoot(ws, (name) => closeOut(name, {}, d));
    assert.equal(updated, false);
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
    await assert.rejects(adoptPr(ws, { pr: "140" }, d), /already exists/);

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

test("callbackFields: both ids from the env, no host id outside the desktop app", async () => {
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
});

test("callbackMessage: the issue's texts", () => {
  assert.equal(
    callbackMessage("merged", URL9),
    `PR ${URL9} merged. Run \`sandbox pr status\`, then follow the workspace router.`,
  );
  assert.equal(
    callbackMessage("shipped", URL9, "v1.2.0"),
    `PR ${URL9} shipped in v1.2.0. Ask the person whether to run \`sandbox close-out\`.`,
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
  const prev = process.env.SANDBOX_WORKSPACES_ROOT;
  process.env.SANDBOX_WORKSPACES_ROOT = root;
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
    if (prev === undefined) delete process.env.SANDBOX_WORKSPACES_ROOT;
    else process.env.SANDBOX_WORKSPACES_ROOT = prev;
    clean(root);
  }
});
