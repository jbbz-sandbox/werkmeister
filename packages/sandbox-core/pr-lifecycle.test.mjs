// The workspace PR lifecycle (docs/workspace-lifecycle.md). PR files, the gate's
// decisions, lifecycle state and close-out ordering are real; git, gh, docker,
// HTTP and the issue tracker are stubbed at the `deps` seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  abandonWorkspace,
  closeOut,
  lifecycleOf,
  mapTouched,
  openPrs,
  prFileDir,
  readPrFiles,
  refreshPrStatus,
  removalBlockers,
  runGate,
  writePrFields,
} from "./dist/pr_lifecycle.js";
import { removeWorkspace, WorkspaceError } from "./dist/sandbox.js";
import { withSandboxHome } from "./fixtures.mjs";

const PASS_BODY = "## Acceptance\n| criterion | result |\n|---|---|\n| works | PASS |\n";

function prFile({ status = "approved", body = PASS_BODY, extra = "" } = {}) {
  return `---\nrepo: o/app\nbranch: me/ws\nbase: main\nstatus: ${status}\n${extra}---\n# feat: the title\n\n${body}`;
}

/** A temp ICM workspace: stages 01_research (done), 02_implement (exercise.md), 03_propose. */
function icmWorkspace({ files = { app: prFile() }, exercise = "| smoke | PASS |\n", researchDone = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-life-"));
  const out = (d) => path.join(ws, "stages", d, "output");
  for (const d of ["01_research", "02_implement", "03_propose"]) fs.mkdirSync(out(d), { recursive: true });
  if (researchDone) fs.writeFileSync(path.join(out("01_research"), "decisions.md"), "x");
  if (exercise !== null) fs.writeFileSync(path.join(out("02_implement"), "exercise.md"), exercise);
  for (const [dir, text] of Object.entries(files)) fs.writeFileSync(path.join(out("03_propose"), `pr-${dir}.md`), text);
  fs.mkdirSync(path.join(ws, ".sandbox"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".sandbox", "workspace.yml"), "feature: feat\nservices: api,lib\nissue_id: o/app#7\nwork_type: feature\n");
  fs.writeFileSync(path.join(ws, ".env"), "FEATURE=feat\nSANDBOX_SLOT=1\n");
  return ws;
}

/** Stub `run`: the first [pattern, result] whose pattern matches `bin args…` wins; records every call. */
function stubRun(table) {
  const calls = [];
  const run = async (bin, args) => {
    const line = [bin, ...args].join(" ");
    calls.push(line);
    for (const [re, res] of table) if (re.test(line)) return { stdout: "", stderr: "", code: 0, ...res };
    return { stdout: "", stderr: "", code: 0 };
  };
  return { run, calls };
}

const REGISTRY = {
  services: {
    api: { type: "api", port_offset: 2, health_endpoint: "/health", test: "npm test -w api" },
    lib: { type: "library", port_offset: 3 },
  },
  repos: { app: { services: ["api", "lib"], path_mappings: { "apps/api": "api", "packages/lib": "lib" }, ship: "tag", release_tag: "v*", release_check: "npx changeset status" } },
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
    tracker: { fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }), updateIssue: async () => {} },
    doneStatus: "closed",
    commitRecord: async () => ({ ok: true, message: "record pushed" }),
    remove: async () => ({ output: "removed" }),
    sourceOf: async () => "/src/app",
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
    assert.equal(prFileDir(ws), path.join(ws, ".sandbox", "notes"));
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

const DIFF_API = [/git -C \S+ diff --name-only origin\/main\.\.\.HEAD/, { stdout: "apps/api/x.ts\n" }];

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

test("gate fails on an unfinished stage, a FAIL row and missing exercise evidence", async () => {
  const ws = icmWorkspace({ researchDone: false, exercise: null, files: { app: prFile({ body: "| x | FAIL |\n" }) } });
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
  const skipped = icmWorkspace({ files: { app: prFile({ extra: "skip_tests:\n  lib: pure types, covered by api tests\n" }) } });
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

test("gate: dirty worktree, failing test, down health endpoint, unapproved", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "draft" }) } });
  try {
    const d = deps([DIFF_API, [/status --porcelain/, { stdout: " M x.ts\n" }], [/npm test -w api/, { code: 1, stdout: "1 failing" }]], {
      httpStatus: async () => 502,
    });
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
      tracker: { fetchIssue: async () => null, updateIssue: async (ref, u) => (updated = [ref, u.status]) },
      commitRecord: async (_ws, _msg, paths) => ((recorded = paths), { ok: true, message: "record pushed" }),
    });
    const r = await open(ws, d);
    assert.ok(r.ok, r.lines.join("\n"));
    const [f] = readPrFiles(ws);
    assert.equal(f.fm.status, "open");
    assert.equal(f.fm.url, "https://github.com/o/app/pull/9");
    assert.deepEqual(updated, ["o/app#7", "In Development"]);
    assert.deepEqual(recorded, ["stages/03_propose/output/pr-app.md"], "the record commit names only the PR file");
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
  const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: https://x/pr/9\n" }) } });
  try {
    const merged = [/^gh pr view/, { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc123" } }) }];
    await refreshPrStatus(ws, deps([merged, [/tag --contains abc123 --list v\*/, { stdout: "" }]]));
    assert.equal(readPrFiles(ws)[0].fm.status, "merged");
    assert.equal(readPrFiles(ws)[0].fm.merge_sha, "abc123");
    const r = await refreshPrStatus(ws, deps([[/tag --contains abc123/, { stdout: "v1.2.0\nv1.3.0\n" }]]));
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped");
    assert.equal(readPrFiles(ws)[0].fm.release, "v1.2.0");
    assert.ok(r.changed);
  } finally {
    clean(ws);
  }
});

test("refreshPrStatus: ship: merge (or skip_release) ships on merge", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "merged", extra: "merge_sha: abc\nskip_release: docs\n" }) } });
  try {
    await refreshPrStatus(ws, deps([]));
    assert.equal(readPrFiles(ws)[0].fm.status, "shipped");
  } finally {
    clean(ws);
  }
});

test("removalBlockers: an open PR, unmerged commits; merged and closed-out are fine", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }), lib: prFile({ status: "merged" }) } });
  const trees = [{ repo: "app", dir: "/w/app" }, { repo: "lib", dir: "/w/lib" }, { repo: "other", dir: "/w/other" }];
  try {
    const { run } = stubRun([[/rev-parse --abbrev-ref origin\/HEAD/, { stdout: "origin/main\n" }], [/rev-list --count origin\/main\.\.HEAD/, { stdout: "2\n" }]]);
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
  const ws = icmWorkspace({ files: { app: prFile({ status: "open" }), lib: prFile({ status: "shipped" }) } });
  try {
    abandonWorkspace(ws, "superseded by #140");
    const byDir = Object.fromEntries(readPrFiles(ws).map((f) => [f.dir, f.fm]));
    assert.equal(byDir.app.status, "abandoned");
    assert.equal(byDir.app.reason, "superseded by #140");
    assert.equal(byDir.lib.status, "shipped");
    assert.match(fs.readFileSync(path.join(ws, "closeout.md"), "utf8"), /Abandoned: superseded by #140/);
  } finally {
    clean(ws);
  }
});

// The machine's config.yaml names its own workspaces_root, so a throwaway one replaces it.
const inWorkspacesRoot = (ws, fn) =>
  withSandboxHome(() => fn(path.basename(ws)), { config: `paths:\n  workspaces_root: ${path.dirname(ws)}\n` });

test("removeWorkspace refuses while a PR is open, before touching anything", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "open", extra: "url: u\n" }) } });
  fs.mkdirSync(path.join(ws, "app", ".git"), { recursive: true });
  try {
    const err = await inWorkspacesRoot(ws, (name) => removeWorkspace(name).then(() => null, (e) => e));
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
    const err = await inWorkspacesRoot(ws, (name) => closeOut(name, deps([])).then(() => null, (e) => e));
    assert.match(String(err), /is merged \(app: merged\)/);
    assert.ok(!fs.existsSync(path.join(ws, "closeout.md")));
  } finally {
    clean(ws);
  }
});

test("closeOut: closes the issue, records, removes, then deletes merged branches", async () => {
  const ws = icmWorkspace({ files: { app: prFile({ status: "shipped", extra: "url: https://x/pr/9\nmerge_sha: abc\nrelease: v1.2.0\n" }) } });
  try {
    const order = [];
    let issue = null;
    const d = deps([[/ls-remote/, { code: 2 }]], {
      tracker: { fetchIssue: async () => ({ ref: "o/app#7", status: "OPEN" }), updateIssue: async (ref, u) => (issue = [ref, u.status]) },
      remove: async () => {
        order.push("remove");
        assert.match(fs.readFileSync(path.join(ws, "closeout.md"), "utf8"), /\| o\/app \| https:\/\/x\/pr\/9 \| shipped \| abc \| v1\.2\.0 \|/);
        return { output: "removed" };
      },
    });
    const origRun = d.run;
    d.run = async (bin, args) => {
      if (args.includes("branch")) order.push("branch -D");
      return origRun(bin, args);
    };
    const r = await inWorkspacesRoot(ws, (name) => closeOut(name, d));
    assert.deepEqual(issue, ["o/app#7", "closed"]);
    assert.deepEqual(order, ["remove", "branch -D"]);
    assert.ok(d.calls.includes("git -C /src/app branch -D me/ws"));
    assert.ok(!d.calls.some((c) => c.includes("push origin --delete")), "remote already gone (ls-remote exit 2)");
    assert.match(r.output, /origin\/me\/ws already gone/);
  } finally {
    clean(ws);
  }
});
