// SW-1128: `metrics rebuild` reads every branch's author in one git call.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { sandboxHome } from "../dist/config.js";
import { rebuildMetrics } from "../dist/metrics_rebuild.js";
import { withSandboxHome } from "./fixtures.mjs";

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

const TEAM_CONFIG = { config: "paths:\n  repos_root: ~/repos\n  workspaces_root: ~/ws\n" };

/** An origin with one record branch per entry of *branches* ({ name, email, files }) and the shared checkout cloned from it. */
function teamRepo(branches) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "team-")));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  const commitAs = (email, files) => {
    for (const [rel, body] of Object.entries(files))
      fs.writeFileSync(path.join(work, rel), `${body}\n`);
    git(work, "add", "-A");
    git(work, "-c", `user.email=${email}`, "-c", "user.name=n", "commit", "-q", "-m", "c");
  };
  commitAs("t@t", { "README.md": "scaffold" });
  for (const b of branches) {
    git(work, "checkout", "-q", "-b", b.name, "main");
    commitAs(b.email, b.files);
  }
  git(work, "checkout", "-q", "main");
  const origin = path.join(root, "origin.git");
  git(root, "clone", "-q", "--bare", work, origin);
  fs.mkdirSync(path.join(os.homedir(), "repos"));
  git(root, "clone", "-q", origin, path.join(os.homedir(), "repos", "sandbox-workspace"));
  fs.mkdirSync(path.join(os.homedir(), "ws"));
  return root;
}

/** A `git` first on PATH that logs each call's args to `<dir>/calls`, and fails `cat-file` when *failCatFile*. */
function gitShim(dir, { failCatFile = false } = {}) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
${failCatFile ? `case " $* " in *" cat-file "*) echo "fatal: boom" >&2; exit 128 ;; esac` : ""}
exec "${real}" "$@"
`,
    { mode: 0o755 },
  );
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prev}`;
  return {
    calls: () => fs.readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean),
    restore: () => {
      process.env.PATH = prev;
    },
  };
}

const usageJson = (workspace) =>
  JSON.stringify({ schema: 1, workspace, closedAt: "2026-11-18T07:00:00.000Z" });

// SW-1128: the authors come from one for-each-ref, not one `git log` per branch.
test("rebuild reads every branch's author in one git call (SW-1128)", async () => {
  await withSandboxHome(async () => {
    const root = teamRepo(
      ["a", "b", "c"].map((p) => ({
        name: `${p}/ws-${p}`,
        email: `${p}@x`,
        files: { "usage.json": usageJson(`ws-${p}`) },
      })),
    );
    const shim = gitShim(path.join(root, "shim"));
    let calls;
    try {
      assert.equal((await rebuildMetrics()).usages, 3);
      calls = shim.calls();
    } finally {
      shim.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(calls.filter((c) => /\bfor-each-ref\b/.test(c)).length, 1, calls.join("\n"));
    assert.equal(calls.filter((c) => /%ae/.test(c)).length, 0, "no git log per branch");
    const cache = fs
      .readFileSync(path.join(sandboxHome(), "metrics", "usage-branches.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(cache.map((u) => [u.workspace, u.by]).sort(), [
      ["ws-a", "a@x"],
      ["ws-b", "b@x"],
      ["ws-c", "c@x"],
    ]);
  }, TEAM_CONFIG);
});
