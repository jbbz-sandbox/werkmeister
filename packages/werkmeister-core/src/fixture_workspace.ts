/**
 * The one fixture built-CLI exercises and core tests run against (SW-292, absorbs SW-234), so no
 * session rebuilds it by hand from `validate:` prose: a temp registry, a workspace whose code repo
 * has a local bare origin, logging fakes for gh and docker, and dead Docker and daemon addresses.
 * `.werkmeister/bin/with-fixture-workspace` (generated at init) runs the built CLI inside one.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { containerOf } from "./config.js";
import { dotDir } from "./dot_dir.js";

export interface FixtureOptions {
  /** services.yaml text; copied in, never symlinked (SW-232). Default: one `lib` service at packages/lib. */
  services?: string;
  /** Add an approved PR file, `origin/main`, and a one-file change in packages/lib for `pr gate`. */
  gate?: boolean;
  /** No feature and no issue, so close-out skips teardown and the tracker (SW-114). */
  bare?: boolean;
}

export interface Fixture {
  root: string;
  configFile: string;
  /** The workspace folder; commands run from here. */
  workspace: string;
  /** The workspace's code worktree, branch `me/demo`, origin a local bare repo. */
  repo: string;
  ghLog: string;
  dockerLog: string;
  /** What a process needs to run against the fixture, HOME (`<root>/home`, empty) included. */
  env: Record<string, string>;
}

export const FIXTURE_FEATURE = "demo";
export const FIXTURE_BRANCH = "me/demo";
export const FIXTURE_REPO_SLUG = "o/app";

const SERVICES = `services:
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
`;

// High base_port, so a real `up` from a fixture (SW-284) can't clash with real workspaces' slots.
const PORTS = `feature_slots:
  count: 4
  base_port: 39100
  ports_per_slot: 20
`;

const PASS = "| check | result |\n|---|---|\n| fixture | PASS |\n";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

// One log line per call, newlines folded (the gate execs a multi-line script). Unknown subcommands exit 1, so a code path the fake doesn't cover fails loudly (SW-148).
// `pr list` prints nothing: pr open's --jq leaves no URL when no PR is open.
const fakeGh = (log: string) => `#!/bin/sh
printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> '${log}'
case "$1 $2" in
  "auth status") echo "  ✓ Logged in to github.com account octo (keyring)" >&2;;
  "api user") echo octo;;
  "search prs") echo '[]';;
  "pr list") ;;
  "pr create") echo "https://github.com/${FIXTURE_REPO_SLUG}/pull/1";;
  *) echo "fake gh: unhandled: $*" >&2; exit 1;;
esac
`;

// Only the gate's `ps --format {{.Names}}\t{{.State}}` sees the fixture's containers (so it execs its tests
// here and logs them); every other `ps` (-q/-aq by label, a label --format) finds none, so no teardown
// of a pre-rename project runs on a fake hit.
const fakeDocker = (log: string, running: string[]) => `#!/bin/sh
printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> '${log}'
case "$1" in
  ps) case "$*" in *"{{.Names}}"*) printf '${running.map((c) => `${c}\\trunning\\n`).join("")}';; esac;;
  inspect) echo false;;
  exec|stop|compose|network) ;;
  *) echo "fake docker: unhandled: $*" >&2; exit 1;;
esac
`;

function write(file: string, body: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, mode === undefined ? undefined : { mode });
}

/** Seed a fixture under *root* (an empty folder, real path) and return where things are. */
export function seedFixture(root: string, opts: FixtureOptions = {}): Fixture {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...GIT_ENV } });

  write(path.join(root, "services.yaml"), opts.services ?? SERVICES);
  write(path.join(root, "ports.yaml"), PORTS);
  const configFile = path.join(root, "config.yaml");
  write(
    configFile,
    `version: 1
paths:
  repos_root: ${root}/repos
  workspaces_root: ${root}/ws
overrides:
  services_yaml: ${root}/services.yaml
  ports_yaml: ${root}/ports.yaml
`,
  );

  // Ends in owner/repo.git so originSlug matches the PR file's repo: (SW-381).
  const remote = path.join(root, "remotes", `${FIXTURE_REPO_SLUG}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  // The source clone sits on another branch, so a worktree can check out main (SW-234).
  const source = path.join(root, "repos", "app");
  fs.mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  git(source, "commit", "-q", "--allow-empty", "-m", "init");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-q", "origin", "main");

  const workspace = path.join(root, "ws", FIXTURE_FEATURE);
  write(
    path.join(dotDir(workspace), "workspace.yml"),
    opts.bare ? "task: demo\nwork_type: feature\n" : `feature: ${FIXTURE_FEATURE}\nservices: lib\n`,
  );
  const repo = path.join(workspace, "app");
  git(workspace, "clone", "-q", remote, "app");

  if (opts.gate) {
    write(path.join(repo, "packages", "lib", "index.js"), "export const v = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "push", "-q", "origin", "main");
  }
  git(repo, "switch", "-q", "-c", FIXTURE_BRANCH);
  git(source, "switch", "-q", "-c", "fixture-source");
  if (opts.gate) {
    write(path.join(repo, "packages", "lib", "index.js"), "export const v = 2;\n");
    git(repo, "commit", "-q", "-am", "change lib");
    // No stages/ folder: the gate reads the PR file and exercise.md from .werkmeister/notes.
    const notes = path.join(dotDir(workspace), "notes");
    write(
      path.join(notes, "pr-app.md"),
      `---\nrepo: ${FIXTURE_REPO_SLUG}\nbranch: ${FIXTURE_BRANCH}\nbase: main\nstatus: approved\n---\n# feat: fixture change\n\n${PASS}`,
    );
    write(path.join(notes, "exercise.md"), PASS);
  }

  // The workspace folder is a git repo with its own local origin, like a real one, so `pr open`
  // commits and pushes the record (its code clone is ignored).
  const record = path.join(root, "remotes", "o", "ws.git");
  fs.mkdirSync(record, { recursive: true });
  git(record, "init", "-q", "--bare", "-b", "main");
  write(path.join(workspace, ".gitignore"), "/app/\n");
  git(workspace, "init", "-q", "-b", FIXTURE_BRANCH);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "record");
  git(workspace, "remote", "add", "origin", record);
  git(workspace, "push", "-q", "-u", "origin", FIXTURE_BRANCH);

  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const ghLog = path.join(root, "gh.log");
  const dockerLog = path.join(root, "docker.log");
  const running = opts.gate ? [containerOf(FIXTURE_FEATURE, "lib")] : [];
  write(path.join(root, "bin", "gh"), fakeGh(ghLog), 0o755);
  write(path.join(root, "bin", "docker"), fakeDocker(dockerLog, running), 0o755);

  return {
    root,
    configFile,
    workspace,
    repo,
    ghLog,
    dockerLog,
    env: {
      ...GIT_ENV,
      // os.homedir() reads HOME, so tokens, locks and anything else under ~ stay in the fixture.
      HOME: home,
      WERKMEISTER_CONFIG_FILE: configFile,
      WERKMEISTER_FIXTURE: "1",
      WERKMEISTER_GH_BIN: path.join(root, "bin", "gh"),
      WERKMEISTER_DOCKER_BIN: path.join(root, "bin", "docker"),
      // dockerode honours DOCKER_HOST before any context, so no engine call reaches the host (SW-164).
      // A fixed short path: one under a deep temp root passes macOS's 104-byte socket limit and crashes with EINVAL.
      DOCKER_HOST: "unix:///nonexistent/werkmeister-fixture-docker.sock",
      // jiraCreds() reads these before config; blank, the fixture config's missing `jira:` wins.
      JIRA_BASE_URL: "",
      JIRA_EMAIL: "",
      JIRA_API_TOKEN: "",
      // Unreachable unless the caller points it at a fake daemon (SW-264, SW-263).
      WERKMEISTER_HOST: process.env["WERKMEISTER_HOST"] || "http://127.0.0.1:1",
    },
  };
}

const SCRIPT = `#!/bin/sh
# Generated by \`werkmeister workspace init\` (SW-292); rerun it to regenerate.
# Runs this workspace's own built werkmeister CLI against a seeded fixture workspace, removed on exit:
# temp HOME and registry, a local bare origin, logging fakes for gh and docker, dead Docker and daemon.
# usage: with-fixture-workspace [--no-wait] [--gate] [--bare] [--services <file>] [--print <file>]... <werkmeister args> [--then <werkmeister args>]...
# It only ever runs that CLI, never another command, so one allow rule can cover it (SW-172, SW-231).
ws=$(cd "$(dirname "$0")/../.." && pwd -P) || exit 1
main=
for f in "$ws"/*/apps/cli/dist/main.js; do
  [ -f "$f" ] || continue
  [ -z "$main" ] || { echo "with-fixture-workspace: more than one built CLI under $ws" >&2; exit 2; }
  main=$f
done
[ -n "$main" ] || { echo "with-fixture-workspace: no built CLI at $ws/<worktree>/apps/cli/dist/main.js; build it first" >&2; exit 2; }
# --no-wait first goes to with-temp-home, like its own (SW-367).
nw=
[ "\${1:-}" != --no-wait ] || { nw=--no-wait; shift; }
exec "$(dirname "$0")/with-temp-home" $nw node "$main" internal fixture "$@"
`;

export function fixtureWrapper(workspaceRoot: string): string {
  return path.join(dotDir(workspaceRoot), "bin", "with-fixture-workspace");
}

/** Write the wrapper, executable, over any earlier copy; returns its path. */
export function writeFixtureWrapper(workspaceRoot: string): string {
  const target = fixtureWrapper(workspaceRoot);
  write(target, SCRIPT);
  // writeFileSync's mode applies only to a file it creates.
  fs.chmodSync(target, 0o755);
  return target;
}
