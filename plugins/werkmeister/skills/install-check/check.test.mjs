// check.sh --fix against a stand-in checkout, with pnpm/corepack/npm faked on PATH (SW-319).
// Run: node --test plugins/werkmeister/skills/install-check/check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const CHECK = path.join(import.meta.dirname, "check.sh");
let t, repo, bin, log;

function write(p, body, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mode) fs.chmodSync(p, mode);
}

/** A fake that records its argv; `fail` makes it exit 1. */
function fake(name, fail = false) {
  write(
    path.join(bin, name),
    `#!/bin/sh\necho "${name} $*" >>"${log}"\nexit ${fail ? 1 : 0}\n`,
    0o755,
  );
}

beforeEach(() => {
  t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-check-")));
  repo = path.join(t, "repo");
  bin = path.join(t, "bin");
  log = path.join(t, "calls.log");
  const cli = path.join(repo, "apps/cli");
  write(path.join(cli, "werkmeister"), "#!/bin/sh\n", 0o755);
  write(path.join(cli, "w9r"), "#!/bin/sh\n", 0o755);
  write(path.join(cli, "dist/main.js"), "");
  // A main pull: core and CLI source newer than the CLI bundle.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(cli, "dist/main.js"), old, old);
  write(path.join(repo, "packages/werkmeister-core/src/a.ts"), "");
  write(path.join(cli, "src/main.ts"), "");
  write(
    path.join(repo, "plugins/werkmeister/.mcp.json"),
    JSON.stringify({ mcpServers: { werkmeister: { command: "werkmeister" } } }),
  );
  const home = path.join(t, "home");
  write(path.join(home, ".werkmeister/env.sh"), `export WERKMEISTER_ROOT=${cli}\n`);
  write(
    path.join(home, ".claude/settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: path.join(repo, "plugins/werkmeister") } }),
  );
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(cli, "werkmeister"), path.join(bin, "werkmeister"));
  fs.symlinkSync(path.join(cli, "w9r"), path.join(bin, "w9r"));
  fake("npm", true); // never reached: the binaries resolve into the repo
});
afterEach(() => fs.rmSync(t, { recursive: true, force: true }));

function run(...args) {
  const env = { ...process.env, HOME: path.join(t, "home"), WERKMEISTER_REPO: repo };
  env.PATH = `${bin}:${process.env.PATH}`;
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const r = spawnSync("bash", [CHECK, ...args], { env, encoding: "utf8" });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, calls };
}

test("--fix on a stale dist installs first, then builds core and the CLI", () => {
  fake("pnpm");
  fake("corepack");
  const r = run("--fix");
  const pm = r.calls.map((c) => c.replace(/^corepack /, ""));
  const install = pm.findIndex((c) => /^pnpm install --frozen-lockfile/.test(c));
  // turbo's werkmeister#build depends on ^build, so this one filter also builds werkmeister-core.
  const build = pm.findIndex((c) => /^pnpm turbo run build .*--filter=werkmeister\b/.test(c));
  assert.ok(install >= 0, `no pnpm install --frozen-lockfile in ${JSON.stringify(r.calls)}`);
  assert.ok(build > install, `no turbo build after the install in ${JSON.stringify(r.calls)}`);
  assert.match(r.stdout, /^FIX /m);
});

test("a failed rebuild reports ERROR and no FIX line, so nothing asks for a restart", () => {
  fake("pnpm", true);
  fake("corepack", true);
  const r = run("--fix");
  assert.match(r.stdout, /^ERROR /m);
  assert.doesNotMatch(r.stdout, /^FIX {3}.*build/m);
  assert.equal(r.status, 1);
});

/** An installed extension folder, aged *ageMs*, and one extension source file written now. */
function extension(ageMs) {
  const ext = path.join(t, "home/.vscode/extensions/jbbz.werkmeister-vscode-0.70.1");
  fs.mkdirSync(ext, { recursive: true });
  write(path.join(repo, "packages/werkmeister-vscode/src/extension.ts"), "");
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(ext, at, at);
}

test("an installed extension older than its source is drift, reported and never installed", () => {
  extension(60_000);
  const r = run();
  assert.match(
    r.stdout,
    /^DRIFT VS Code extension jbbz\.werkmeister-vscode-0\.70\.1 is older .*install:local/m,
  );
  assert.doesNotMatch(r.calls.join("\n"), /code /);
});

test("an extension installed after its source changed is up to date", () => {
  extension(-60_000);
  assert.match(run().stdout, /^OK {4}VS Code extension .* is up to date/m);
});

/** Makes the stand-in checkout a git repo on `branch` whose origin is one commit ahead, in a file --fix alone never watches. */
function behindOrigin(branch = "main") {
  const git = (cwd, ...a) => {
    const r = spawnSync("git", a, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, ...id, "commit", "-qm", "base");
  const origin = path.join(t, "origin.git");
  git(t, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "-q", "-u", "origin/main");
  const other = path.join(t, "other");
  git(t, "clone", "-q", origin, other);
  write(path.join(other, "apps/werkmeister-mcp/src/x.ts"), "");
  git(other, "add", "-A");
  git(other, ...id, "commit", "-qm", "ahead");
  git(other, "push", "-q");
  if (branch !== "main") git(repo, "checkout", "-q", "-b", branch);
  // dist newer than every source --fix watches: only the pull makes it stale.
  fs.utimesSync(path.join(repo, "apps/cli/dist/main.js"), new Date(), new Date());
}

test("--pull fast-forwards main, prints the commit to roll back to, and builds every package", () => {
  behindOrigin();
  fake("pnpm");
  fake("corepack");
  const r = run("--pull");
  assert.match(r.stdout, /^PULL {2}main \w+ -> \w+ \(roll back: git -C .* checkout \w+/m);
  assert.ok(fs.existsSync(path.join(repo, "apps/werkmeister-mcp/src/x.ts")), "not pulled");
  const build = r.calls.find((c) => / turbo run build/.test(c));
  assert.ok(build, `no build in ${JSON.stringify(r.calls)}`);
  assert.doesNotMatch(build, /--filter/);
  assert.match(r.stdout, /^FIX .*turbo run build$/m);
});

test("--pull off main pulls and builds nothing", () => {
  behindOrigin("jayboyer/feature");
  fake("pnpm");
  fake("corepack");
  const r = run("--pull");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^ERROR --pull: .* is on jayboyer\/feature, not main/m);
  assert.equal(r.calls.length, 0, JSON.stringify(r.calls));
  assert.ok(!fs.existsSync(path.join(repo, "apps/werkmeister-mcp/src/x.ts")));
});

/** A fake gh: checks pass unless CHECKS_RC says otherwise, the queue reports QUEUE_STATE. */
function fakeGh() {
  write(
    path.join(bin, "gh"),
    `#!/bin/sh
case "$*" in
  "pr checks"*--watch*) exit \${CHECKS_RC:-0} ;;
  "pr checks"*) echo "test	pass" ;;
  *headRefOid*) echo abc123 ;;
  "pr view"*"--json id"*) echo PR_ID ;;
  *enqueuePullRequest*) echo "enqueue $*" >>"${log}"; echo '{}' ;;
  "api graphql"*) echo "\${QUEUE_STATE:-MERGED false}" ;;
esac
`,
    0o755,
  );
}

function queue(env = {}) {
  const r = spawnSync("bash", [path.join(import.meta.dirname, "queue-pr.sh"), "7", "o/r"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      QUEUE_PR_INTERVAL: "0",
      QUEUE_PR_TRIES: "2",
      ...env,
    },
    encoding: "utf8",
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, calls };
}

test("queue-pr queues a PR whose checks pass and waits for the merge", () => {
  fakeGh();
  const r = queue();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^QUEUED #7\nMERGED #7$/m);
  assert.match(r.calls.join("\n"), /enqueue .*PR_ID/);
});

test("queue-pr never queues a PR whose checks failed, and reports one that left the queue", () => {
  fakeGh();
  const failed = queue({ CHECKS_RC: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^ERROR #7 checks failed/m);
  assert.equal(failed.calls.length, 0);
  const dropped = queue({ QUEUE_STATE: "OPEN false" });
  assert.equal(dropped.status, 1);
  assert.match(dropped.stdout, /^ERROR #7 left the queue unmerged/m);
});
