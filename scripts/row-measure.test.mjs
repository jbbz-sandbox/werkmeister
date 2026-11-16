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
  # HIGH_AT's first HIGH_TIMES attempts (default 1) report other workspaces' load, with a wall time the medians must not show.
  mkdir -p "$out/$l" && n=$(cat "$out/.n-$l" 2>/dev/null || echo 0) && echo $((n + 1)) >"$out/.n-$l"
  wall=$(cat "$REPO/a.txt") others=0
  if [ "$l" = "\${HIGH_AT:-}" ] && [ "$n" -lt "\${HIGH_TIMES:-1}" ]; then wall=999 others=188.8; fi
  printf 'label %s\\nwall_s %s\\ncpu_s 1\\nothers_cpu_s %s\\n' "$l" "$wall" "$others" >"$out/$l/totals.txt" ;;
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
  return { repo, ab, out: join(ws, "out") };
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

test("ab-row reruns a run whose others_cpu_s is over the limit and keeps it out of the medians", async () => {
  const { repo, ab, out } = await abRepo();
  const { stdout } = await ab({ HIGH_AT: "B1" });
  const abTxt = readFileSync(join(out, "ab.txt"), "utf8");
  assert.match(abTxt, /^B1 wall 999 s .*others 188\.8 s .* rerun: others 188\.8 s$/m);
  assert.match(abTxt, /^B1 wall 20 s .*others 0 s [^\n]*exit $/m);
  assert.match(stdout, /median B wall 20\.0 s/);
  assert.equal(
    readFileSync(join(out, "B1.try1", "totals.txt"), "utf8").includes("wall_s 999"),
    true,
  );
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "20\n");
});

test("ab-row keeps and flags the last run when the tries run out, and ROW_OTHERS_TRIES=1 never reruns", async () => {
  const { ab, out } = await abRepo();
  const { stdout } = await ab({ HIGH_AT: "B1", HIGH_TIMES: "9" });
  const abTxt = readFileSync(join(out, "ab.txt"), "utf8");
  assert.equal(abTxt.match(/rerun: others/g).length, 1);
  assert.match(abTxt, /^B1 .* flagged: others 188\.8 s over 30 s after 2 tries$/m);
  assert.match(stdout, /median B wall 509\.5 s/); // B1 kept at 999, B2 at 20
  const once = await abRepo();
  await once.ab({ HIGH_AT: "B1", ROW_OTHERS_TRIES: "1" });
  const onceTxt = readFileSync(join(once.out, "ab.txt"), "utf8");
  assert.doesNotMatch(onceTxt, /rerun: others/);
  assert.match(onceTxt, /flagged: others 188\.8 s over 30 s after 1 tries/);
});

test("ab-row rejects a bad ROW_OTHERS_TRIES", async () => {
  const { ab } = await abRepo();
  await assert.rejects(ab({ ROW_OTHERS_TRIES: "0" }), (e) => {
    assert.equal(e.code, 1);
    assert.match(e.stderr, /ROW_OTHERS_TRIES takes an attempt count, got '0'/);
    return true;
  });
});

test("measure_one prints the row's cgroup CPU-s and rc, and returns 0 when the command fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mtc-"));
  const stat = join(dir, "cpu.stat");
  writeFileSync(stat, "usage_usec 1000000\n");
  const env = { ROW_CGROUP_STAT: stat, STAT: stat };
  const bump = `sh -c 'echo "usage_usec 3500000" > "$STAT"; exit 3'`;
  const { stdout } = await sh(
    `measure_one core test/a.test.mjs "${join(dir, "a.log")}" ${bump}`,
    env,
  );
  const [suite, file, rc, , cpu] = stdout.trim().split("\t");
  assert.deepEqual([suite, file, rc, cpu], ["core", "test/a.test.mjs", "3", "2.5"]);
});

test("measure-test-cpu checks its arguments before it measures", async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "mtc-ws-")));
  mkdirSync(join(ws, ".werkmeister", "bin"), { recursive: true });
  writeFileSync(join(ws, ".werkmeister", "bin", "with-temp-home"), "#!/bin/sh\n", { mode: 0o755 });
  const mtc = (...args) =>
    promisify(execFile)("sh", [join(import.meta.dirname, "measure-test-cpu.sh"), ...args], {
      env: { ...process.env, WERKMEISTER_FEATURE: "" },
    });
  for (const [args, message] of [
    [["-w", ws], /Run in the service's container/],
    [["-w", ws, "-o", join(ws, "out"), "-f", "bogus"], /-f takes core or cli, got 'bogus'/],
    [
      ["-w", join(ws, "nope"), "-o", join(ws, "out")],
      /no .*with-temp-home; is -w the workspace folder/,
    ],
    [["-w", ws, "-o", join(tmpdir(), "elsewhere")], /is outside/],
    [["-w", ws, "-o", join(ws, "out"), "-l", "a/b"], /-l takes a plain name/],
    [["-w", ws, "-o", `${ws}/../escape`], /is outside/],
  ]) {
    await assert.rejects(mtc(...args), (e) => {
      assert.equal(e.code, 2, args.join(" "));
      assert.match(e.stderr, message);
      return true;
    });
  }
  // In a container, -w must be the workspace that container serves.
  writeFileSync(join(ws, ".werkmeister", "workspace.yml"), "feature: other\n");
  const inContainer = promisify(execFile)(
    "sh",
    [join(import.meta.dirname, "measure-test-cpu.sh"), "-w", ws, "-o", join(ws, "out")],
    { env: { ...process.env, WERKMEISTER_FEATURE: "demo" } },
  );
  await assert.rejects(inContainer, (e) => {
    assert.equal(e.code, 2);
    assert.match(e.stderr, /is feature 'other', this container's is 'demo'/);
    return true;
  });
});

test("ab-row looks for the container named after the workspace's feature, not its folder", async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "ab-feat-")));
  mkdirSync(join(ws, ".werkmeister"));
  writeFileSync(join(ws, ".werkmeister", "workspace.yml"), "feature: demo\n");
  mkdirSync(join(ws, "bin"));
  writeFileSync(join(ws, "bin", "docker"), "#!/bin/sh\necho false\n", { mode: 0o755 });
  const repo = join(ws, "repo");
  mkdirSync(repo);
  await promisify(execFile)("git", ["init", "-q"], { cwd: repo });
  const ab = promisify(execFile)(
    "sh",
    [join(import.meta.dirname, "ab-row.sh"), "-o", join(ws, "out")],
    {
      cwd: repo,
      env: { ...process.env, PATH: `${join(ws, "bin")}:${process.env.PATH}` },
    },
  );
  await assert.rejects(ab, (e) => {
    assert.match(e.stderr, /^ab-row: demo-werkmeister-core is not running/);
    return true;
  });
});
