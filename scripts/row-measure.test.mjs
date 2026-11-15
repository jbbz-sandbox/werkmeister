import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const lib = join(import.meta.dirname, "row-lib.sh");
const sh = (script, env = {}) =>
  promisify(execFile)("sh", ["-c", `. "${lib}"; ${script}`], { env: { ...process.env, ...env } });

test("median takes the middle value, or the mean of the middle two", async () => {
  assert.equal((await sh("printf '3\\n1\\n2\\n' | median")).stdout, "2.0\n");
  assert.equal((await sh("printf '4\\n1\\n3\\n2\\n' | median")).stdout, "2.5\n");
});

test("busy_between counts busy cores, iowait as idle", async () => {
  // Δtotal 1000, Δidle+iowait 700: 30% of 4 CPUs.
  const a = "cpu  100 0 100 600 100 100 0 0 0 0";
  const b = "cpu  300 0 200 1200 200 100 0 0 0 0";
  assert.equal((await sh(`busy_between "${a}" "${b}"`, { NCPU: "4" })).stdout, "1.2\n");
});

test("test_counts sums vitest, node spec and TAP summaries under turbo prefixes", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "row-")), "row.log");
  writeFileSync(
    log,
    [
      "werkmeister:test:  Test Files  1 failed | 3 passed (4)",
      "werkmeister:test:       Tests  1 failed | 9 passed (10)",
      "werkmeister:test:       Tests  5 passed (5)",
      "werkmeister-mcp:test: ℹ tests 7",
      "werkmeister-mcp:test: ℹ pass 7",
      "werkmeister-mcp:test: ℹ fail 0",
      "werkmeister-core:test: # tests 3",
      "werkmeister-core:test: # pass 2",
      "werkmeister-core:test: # fail 1",
    ].join("\n"),
  );
  assert.equal((await sh(`test_counts "${log}"`)).stdout, "tests 25 pass 23 fail 2\n");
});

test("wait_quiet refuses with 75 above the limit and passes under it", async () => {
  const busy = { ROW_BUSY: "5", ROW_LOAD_LIMIT: "1", ROW_LOAD_WAIT: "0" };
  await assert.rejects(sh("wait_quiet", busy), (e) => {
    assert.equal(e.code, 75);
    assert.match(e.stderr, /VM still busy 5 cores after 0 s; not measuring/);
    return true;
  });
  const quiet = await sh('wait_quiet && echo "ok $busy_before"', { ...busy, ROW_BUSY: "0.5" });
  assert.deepEqual([quiet.stdout, quiet.stderr], ["ok 0.5\n", ""]);
});

// A fake docker on PATH stands in for the container: each "run" records the worktree's a.txt as its wall time,
// so the medians show A ran on the base and B on the branch, and the tree is checked afterwards.
const FAKE_DOCKER = `#!/bin/sh
case $1 in
inspect) case $3 in *Mounts*) echo "$REPO" ;; *) echo true ;; esac ;;
exec)
  while [ $# -gt 0 ]; do case $1 in -o) out=$2 ;; -l) l=$2 ;; esac; shift; done
  [ "$l" != "\${FAIL_AT:-}" ] || exit 75
  mkdir -p "$out/$l" && printf 'label %s\\nwall_s %s\\ncpu_s 1\\n' "$l" "$(cat "$REPO/a.txt")" >"$out/$l/totals.txt" ;;
esac
`;

const abRepo = async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "ab-ws-")));
  const repo = join(ws, "repo");
  mkdirSync(join(ws, ".werkmeister"));
  writeFileSync(join(ws, ".werkmeister", "workspace.yml"), "");
  mkdirSync(join(ws, "bin"));
  writeFileSync(join(ws, "bin", "docker"), FAKE_DOCKER, { mode: 0o755 });
  mkdirSync(repo);
  const git = (...a) =>
    promisify(execFile)(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
      {
        cwd: repo,
      },
    );
  await git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "10\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  writeFileSync(join(repo, "a.txt"), "20\n");
  const ab = (env = {}) =>
    promisify(execFile)(
      "sh",
      [join(import.meta.dirname, "ab-row.sh"), "-o", join(ws, "out"), "-n", "2", "-b", "HEAD"],
      {
        cwd: repo,
        env: { ...process.env, PATH: `${join(ws, "bin")}:${process.env.PATH}`, REPO: repo, ...env },
      },
    );
  return { repo, ab };
};

test("ab-row runs A on the base and B on the branch, and leaves the tree on B", async () => {
  const { repo, ab } = await abRepo();
  const { stdout } = await ab();
  assert.match(stdout, /median A wall 10\.0 s/);
  assert.match(stdout, /median B wall 20\.0 s/);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "20\n");
});

test("ab-row stops on a refused run with 75 and puts the tree back on B", async () => {
  const { repo, ab } = await abRepo();
  await assert.rejects(ab({ FAIL_AT: "A2" }), (e) => {
    assert.equal(e.code, 75);
    assert.match(e.stdout, /A2 refused, VM busy; stopping/);
    return true;
  });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "20\n");
});
