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
import { writeFakes } from "./fixture_fakes.js";

export interface FixtureRepo {
  /** Folder in the workspace and under repos_root; its origin is a local bare `o/<name>.git`. */
  name: string;
  /** A file committed on main (pushed as origin/main), then changed in one commit on the branch. */
  change?: string;
}

/** What to seed. Data, so a new dimension is a field, not another boolean; see fixturePreset. */
export interface FixtureOptions {
  /** services.yaml text; copied in, never symlinked (SW-232). Default: one `lib` service at packages/lib. */
  services?: string;
  /** Default: one repo `app` with no change. */
  repos?: FixtureRepo[];
  /** An approved PR file for each repo with a change, and a passing exercise.md. */
  prFile?: boolean;
  /** Containers the fake docker shows the gate as running. */
  running?: string[];
  /** false: no feature and no issue, so close-out skips teardown and the tracker (SW-114). */
  feature?: boolean;
  /** The workspace's `services:`. Default: `lib`. */
  workspaceServices?: string[];
}

export interface FixturePresets {
  /** An approved PR for a one-file change in packages/lib, with `demo-lib` running, for `pr gate`. */
  gate?: boolean;
  /** No feature (`feature: false`). */
  bare?: boolean;
}

export interface Fixture {
  root: string;
  configFile: string;
  /** The workspace folder; commands run from here. */
  workspace: string;
  /** The first code repo's clone, branch `me/demo`, origin a local bare repo. */
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

/** The `--gate` / `--bare` shorthands as data; any FixtureOptions field passed beside them wins. */
export function fixturePreset({
  gate,
  bare,
  ...opts
}: FixturePresets & FixtureOptions): FixtureOptions {
  const preset: FixtureOptions = {};
  if (gate)
    Object.assign(preset, {
      repos: [{ name: "app", change: "packages/lib/index.js" }],
      prFile: true,
      running: [containerOf(FIXTURE_FEATURE, "lib")],
    });
  if (bare) preset.feature = false;
  return { ...preset, ...opts };
}

function write(file: string, body: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, mode === undefined ? undefined : { mode });
}

/** Seed a fixture under *root* (an empty folder, real path) and return where things are. */
export function seedFixture(root: string, opts: FixtureOptions = {}): Fixture {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...GIT_ENV } });
  const repos = opts.repos ?? [{ name: "app" }];

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

  const workspace = path.join(root, "ws", FIXTURE_FEATURE);
  write(
    path.join(dotDir(workspace), "workspace.yml"),
    opts.feature === false
      ? "task: demo\nwork_type: feature\n"
      : `feature: ${FIXTURE_FEATURE}\nservices: ${(opts.workspaceServices ?? ["lib"]).join(",")}\n`,
  );
  const notes = path.join(dotDir(workspace), "notes");
  for (const { name, change } of repos) {
    // Ends in owner/repo.git so originSlug matches the PR file's repo: (SW-381).
    const remote = path.join(root, "remotes", "o", `${name}.git`);
    fs.mkdirSync(remote, { recursive: true });
    git(remote, "init", "-q", "--bare", "-b", "main");
    // The source clone sits on another branch, so a worktree can check out main (SW-234).
    const source = path.join(root, "repos", name);
    fs.mkdirSync(source, { recursive: true });
    git(source, "init", "-q", "-b", "main");
    git(source, "commit", "-q", "--allow-empty", "-m", "init");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "-q", "origin", "main");

    const repo = path.join(workspace, name);
    git(workspace, "clone", "-q", remote, name);
    if (change) {
      write(path.join(repo, change), "base\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      git(repo, "push", "-q", "origin", "main");
    }
    git(repo, "switch", "-q", "-c", FIXTURE_BRANCH);
    git(source, "switch", "-q", "-c", "fixture-source");
    if (change) {
      write(path.join(repo, change), "changed\n");
      git(repo, "commit", "-q", "-am", `change ${change}`);
    }
    // No stages/ folder: the gate reads the PR file and exercise.md from .werkmeister/notes.
    if (opts.prFile && change)
      write(
        path.join(notes, `pr-${name}.md`),
        `---\nrepo: o/${name}\nbranch: ${FIXTURE_BRANCH}\nbase: main\nstatus: approved\n---\n# feat: fixture change\n\n${PASS}`,
      );
  }
  if (opts.prFile) write(path.join(notes, "exercise.md"), PASS);

  // The workspace folder is a git repo with its own local origin, like a real one, so `pr open`
  // commits and pushes the record (its code clones are ignored).
  const record = path.join(root, "remotes", "o", "ws.git");
  fs.mkdirSync(record, { recursive: true });
  git(record, "init", "-q", "--bare", "-b", "main");
  write(path.join(workspace, ".gitignore"), repos.map((r) => `/${r.name}/\n`).join(""));
  git(workspace, "init", "-q", "-b", FIXTURE_BRANCH);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "record");
  git(workspace, "remote", "add", "origin", record);
  git(workspace, "push", "-q", "-u", "origin", FIXTURE_BRANCH);

  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const fakes = writeFakes(path.join(root, "bin"), {
    prUrl: `https://github.com/${FIXTURE_REPO_SLUG}/pull/1`,
    running: opts.running ?? [],
  });

  return {
    root,
    configFile,
    workspace,
    repo: path.join(workspace, (repos[0] as FixtureRepo).name),
    ghLog: fakes.ghLog,
    dockerLog: fakes.dockerLog,
    env: {
      ...GIT_ENV,
      // os.homedir() reads HOME, so tokens, locks and anything else under ~ stay in the fixture.
      HOME: home,
      WERKMEISTER_CONFIG_FILE: configFile,
      WERKMEISTER_FIXTURE: "1",
      WERKMEISTER_GH_BIN: fakes.gh,
      WERKMEISTER_DOCKER_BIN: fakes.docker,
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
