/**
 * The one fixture built-CLI exercises and core tests run against (SW-292, absorbs SW-234), so no
 * session rebuilds it by hand from `validate:` prose: a temp registry, a workspace whose code repo
 * has a local bare origin, logging fakes for gh and docker, and dead Docker and daemon addresses.
 * `.werkmeister/bin/with-fixture-workspace` (generated at init) runs the built CLI inside one.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

import { waitingPath } from "./agent_state.js";
import { COMPOSE_FILE } from "./compose_file.js";
import { containerOf } from "./config.js";
import { dotDir } from "./dot_dir.js";
import { writeFakes } from "./fixture_fakes.js";
import { gitEnv } from "./proc.js";
import { prDir, stageDirs, templateFor } from "./strategies/icm_templates.js";

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
  /** A repo fragment, written to the first repo's `<repos_root>/<name>/.werkmeister/services.yaml` for `registry sync`. */
  fragment?: string;
  /** WERKMEISTER_HOST for the fixture (a fake daemon's URL). Default, and whatever the caller exports: a dead address. */
  daemon?: string;
  /** The fake docker runs each `docker exec` command in the first repo, so the gate's lint and test rows pass or fail for real (SW-473). */
  execRuns?: boolean;
  /** Merged over the fixture's workspace.yml, e.g. `{ group: ["SW-2"], work_type: "refactor", context_strategy: "icm" }` (SW-464). */
  workspace?: Record<string, unknown>;
  /** The fake gh reports the PR merged, so `pr status` and `workspace close` run to the end (SW-482). */
  merged?: boolean;
  /** origin/main gains 2 commits after the branch is cut, so the branch is behind its base (SW-669). */
  behind?: boolean;
  /** The workspace's `issue_id` (`o/<repo>#N`): resolved by the fixture's GitHub project to the fake gh, whose `issue view` answers it (SW-509). */
  issue?: string;
  /** Extra front matter for each seeded PR file, e.g. `{ skip_release: "tests only" }` (SW-514); `status` replaces `approved`, verbatim (SW-549). */
  prFields?: Record<string, string>;
  /** Raw front matter lines added to each seeded PR file after `prFields`, unquoted, e.g. `skip_release: no changeset: test-only` (SW-851). */
  prLines?: string[];
  /** Every ports.yaml slot leased to `other-N`, each with its own folder so heldSlots keeps it, for no-slot paths (SW-634). */
  slotsFull?: boolean;
  /** The first repo's `.werkmeister/services.yaml` on the branch, committed over a base fragment on main (`fragment`, else the default registry's), so the gate's fragment row compares the two (SW-664). */
  fragmentChange?: string;
  /** With `fragmentChange`: hold the branch's fragment back until `applyFragmentChange`, so a `workspace init` run first renders compose.yml from the base fragment and `pr gate` sees the branch settings as changed (SW-817). */
  staleCompose?: boolean;
  /** The texts `change` holds on main and on the branch, instead of `base` and `changed`, e.g. two pnpm-lock.yaml copies (SW-696). */
  changeBase?: string;
  changeBranch?: string;
  /** Top-level keys added to the fixture's config.yaml, e.g. `{ budget: { host_load: 0.01 } }` (SW-670); fixturePreset refuses any key but CONFIG_KEYS. */
  config?: Record<string, unknown>;
  /** Containers the fake docker shows the scheduler as running, so a start can wait for capacity (SW-685). */
  containers?: FixtureContainer[];
  /**
   * The waiting queue, `scheduler/queue.json` (SW-685), one `<feature>[:<waitedMin>[:<service>,...]]` each.
   * With a wait, the waiter also gets a workspace with a compose.yml, a lease and a waiting.json whose
   * `since` is that many minutes back (and `services`, a service start), so admission prices and ages it (SW-809).
   */
  queue?: string[];
  /** A `postmortem.md` at the workspace root, on the record branch, so close-out runs without `--skip-postmortem` (SW-896). */
  postmortem?: boolean;
  /** Each repo a worktree of its source clone, as init makes them, on `<os user>/demo`, so `pr push` takes it (SW-896). */
  worktrees?: boolean;
  /** JIRA_BASE_URL for the fixture (a fake Jira's URL, `startFakeJira`). Default: blank Jira credentials. */
  jira?: string;
  /** CLAUDE_BIN / CODEX_BIN for the fixture, a fake a test sets on purpose (SW-911). In-process only: the wrapper has no flag for them. Default: blank, the failing stub. */
  claudeBin?: string;
  codexBin?: string;
}

/** One running container as `docker inspect` reports it to the scheduler. */
export interface FixtureContainer {
  feature: string;
  /** A folder name, created empty under the fixture's workspaces root: a person's workspace, never preempted. */
  workspace: string;
  startedAt: string;
  /** Bytes reserved. */
  memory: number;
  nanoCpus: number;
  /** `docker exec`s running in it (SW-856): the scheduler treats any as work in flight. */
  execs?: number;
}

// Names become folders under the fixture and lines in the fakes, from a pre-approved wrapper's input.
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const QUEUE_ENTRY =
  /^([a-z0-9][a-z0-9-]*)(?::(\d+)(?::([a-z0-9][a-z0-9-]*(?:,[a-z0-9][a-z0-9-]*)*))?)?$/;

// The only config.yaml keys --config may add: others (jira, github_ingest, paths…) reach real services or repos from a pre-approved run.
const CONFIG_KEYS = ["budget", "workspace_ask_rules"];
// The only workspace.yml keys --workspace may set (SW-900): text and flags the fixture's own files take, and
// `repos`, whose names init keeps under repos_root. Tracker refs reach the fake gh or blank/fake Jira creds.
const WORKSPACE_KEYS = [
  "auto_stop",
  "autonomous",
  "context_strategy",
  "description",
  "group",
  "issue_id",
  "labels",
  "model",
  "repos",
  "starting_prompt",
  "task",
  "work_type",
];

export interface FixturePresets {
  /** An approved PR for a one-file change in packages/lib, with `demo-lib` running, for `pr gate`. */
  gate?: boolean;
  /** The file `gate` changes instead of packages/lib/index.js, e.g. `plugins/x/y.ts`; with `fragmentChange` and no `change`, only the fragment changes (SW-664). */
  change?: string;
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
  /** With `staleCompose`: commit the branch's held-back fragment (SW-817). */
  applyFragmentChange?: () => void;
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

// SERVICES as repo app's own fragment: the base a `fragmentChange` is diffed against.
const BASE_FRAGMENT = `services:
  lib:
    type: cli
    path: packages/lib
    test: "true"
repo:
  path_mappings:
    packages/lib: lib
`;

const FRAGMENT_FILE = path.join(".werkmeister", "services.yaml");

// Above real workspaces' slots, so a real `up` from a fixture (SW-284) can't clash, and below every
// OS's ephemeral range (Linux 32768+) and k8s NodePorts (30000+), where listen(0) servers and client
// sockets land: one on the gate's port probe read as "held by a host process" (SW-899).
// shortcut: every fixture shares this block, so two parallel gate probes can still meet for under a ms; give each fixture its own block if that flakes.
const PORTS = `feature_slots:
  count: 4
  base_port: 29100
  ports_per_slot: 20
`;

const FIXTURE_PROJECT = "fixture";

// A GitHub project that holds only `o/<repo>#N` refs, so they reach the fake gh while Jira keys
// (SW-2) still resolve to Jira; not `default`, so nothing else moves (SW-509).
const githubProject = (repos: string[]) =>
  `projects:\n  ${FIXTURE_PROJECT}:\n    tracker:\n      id: github\n      org: o\n      repos: [${repos.map((r) => `o/${r}`).join(", ")}]\n`;

// What the fake gh's `issue view` answers for every ref: open, no status label yet.
const FIXTURE_ISSUE = {
  title: "fixture issue",
  state: "OPEN",
  labels: [],
  assignees: [],
  comments: [],
  url: `https://github.com/${FIXTURE_REPO_SLUG}/issues/1`,
};

const PASS = "| check | result |\n|---|---|\n| fixture | PASS |\n";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/**
 * The `--gate` / `--bare` shorthands as data; any FixtureOptions field passed beside them wins.
 * Throws when `gate` meets a registry without `lib` in repo `app` at packages/lib: its change would map to no service.
 */
export function fixturePreset({
  gate,
  bare,
  change,
  ...opts
}: FixturePresets & FixtureOptions): FixtureOptions {
  const preset: FixtureOptions = {};
  const refused = Object.keys(opts.config ?? {}).filter((k) => !CONFIG_KEYS.includes(k));
  if (refused.length)
    throw new Error(`--config may not set ${refused.join(", ")}: only ${CONFIG_KEYS.join(", ")}`);
  const unlisted = Object.keys(opts.workspace ?? {}).filter((k) => !WORKSPACE_KEYS.includes(k));
  if (unlisted.length)
    throw new Error(
      `--workspace may not set ${unlisted.join(", ")}: only ${WORKSPACE_KEYS.join(", ")}`,
    );
  for (const c of opts.containers ?? []) {
    const bad = !NAME.test(c.feature)
      ? c.feature
      : !NAME.test(c.workspace)
        ? c.workspace
        : Number.isNaN(Date.parse(c.startedAt))
          ? c.startedAt
          : [c.memory, c.nanoCpus, c.execs ?? 0].find((n) => !Number.isSafeInteger(n) || n < 0);
    if (bad !== undefined)
      throw new Error(
        `--running: bad value ${JSON.stringify(bad)}: feature and workspace are lowercase names, startedAt a date, memory, nanoCpus and execs whole numbers`,
      );
  }
  const badEntry = opts.queue?.find((q) => !QUEUE_ENTRY.test(q));
  if (badEntry !== undefined)
    throw new Error(
      `--queue: bad entry ${JSON.stringify(badEntry)}: <feature>[:<waitedMin>[:<service>,...]], lowercase names and whole minutes`,
    );
  // A worktree shares its source's origin/main, so it can't stay behind until a fetch.
  if (opts.worktrees && opts.behind) throw new Error("--worktrees and --behind don't combine");
  const libChange = "packages/lib/index.js";
  const gateChange = change ?? (opts.fragmentChange === undefined ? libChange : undefined);
  if (gate && opts.services && gateChange === libChange) {
    const lib = YAML.parse(opts.services)?.services?.lib;
    if (lib?.repo !== "app" || lib?.path !== "packages/lib")
      throw new Error(
        "--gate needs a `lib` service in repo `app` (at packages/lib) in the --services registry",
      );
  }
  if (gate)
    Object.assign(preset, {
      repos: [{ name: "app", change: gateChange }],
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
    execFileSync("git", args, { cwd, stdio: "pipe", env: { ...gitEnv(), ...GIT_ENV } });
  const repos = opts.repos ?? [{ name: "app" }];

  write(path.join(root, "services.yaml"), opts.services ?? SERVICES);
  write(path.join(root, "ports.yaml"), PORTS);
  // At the temp HOME's default path, so `machine migrate` treats it as the home it is (SW-581).
  const home = path.join(root, "home");
  const configFile = path.join(dotDir(home), "config.yaml");
  write(
    configFile,
    `version: 1
paths:
  repos_root: ${root}/repos
  workspaces_root: ${root}/ws
overrides:
  services_yaml: ${root}/services.yaml
  ports_yaml: ${root}/ports.yaml
${githubProject(repos.map((r) => r.name))}${opts.config ? YAML.stringify(opts.config) : ""}`,
  );

  const workspace = path.join(root, "ws", FIXTURE_FEATURE);
  const yml: Record<string, unknown> = {
    ...(opts.feature === false
      ? { task: "demo", work_type: "feature" }
      : { feature: FIXTURE_FEATURE, services: (opts.workspaceServices ?? ["lib"]).join(",") }),
    ...(opts.issue ? { issue_id: opts.issue, project: FIXTURE_PROJECT } : {}),
    ...opts.workspace,
  };
  write(path.join(dotDir(workspace), "workspace.yml"), YAML.stringify(yml));
  // The gate reads the PR file and exercise.md where the strategy keeps them (SW-464): jit's notes,
  // or icm's propose output, with every earlier stage's output non-empty for the stages row.
  let notes = path.join(dotDir(workspace), "notes");
  if (opts.prFile && yml["context_strategy"] === "icm") {
    const stages = templateFor(String(yml["work_type"] ?? ""));
    const dirs = stageDirs(stages);
    const own = prDir(stages);
    notes = path.join(workspace, "stages", own, "output");
    for (const d of dirs.slice(0, dirs.indexOf(own)))
      write(path.join(workspace, "stages", d, "output", "seeded.md"), "seeded by the fixture\n");
    // icm's contracts name a review step, so the gate wants a passing review.md too.
    write(path.join(notes, "review.md"), PASS);
  }
  // status goes in verbatim, so a brief can try the forms people write, comments included (SW-549).
  const { status = "approved", ...prFields } = opts.prFields ?? {};
  // prLines go in as written, so a test can seed what YAML.stringify would quote (SW-851).
  const extra =
    (Object.keys(prFields).length ? YAML.stringify(prFields) : "") +
    (opts.prLines ?? []).map((l) => `${l}\n`).join("");
  let applyFragmentChange: (() => void) | undefined;
  // pr push takes only the workspace's own <os user>/<workspace> branch (pushOne); the clone keeps me/demo.
  const branch = opts.worktrees ? `${os.userInfo().username}/${FIXTURE_FEATURE}` : FIXTURE_BRANCH;
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
    if (opts.fragment && name === repos[0]?.name)
      write(path.join(source, FRAGMENT_FILE), opts.fragment);

    const repo = path.join(workspace, name);
    // Detached: the source still has main checked out until it moves to fixture-source below.
    if (opts.worktrees) git(source, "worktree", "add", "-q", "--detach", repo);
    else git(workspace, "clone", "-q", remote, name);
    const frag = name === repos[0]?.name ? opts.fragmentChange : undefined;
    const changed = [change, frag === undefined ? undefined : FRAGMENT_FILE].filter(Boolean);
    if (changed.length) {
      if (change) write(path.join(repo, change), opts.changeBase ?? "base\n");
      if (frag !== undefined) write(path.join(repo, FRAGMENT_FILE), opts.fragment ?? BASE_FRAGMENT);
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      // HEAD:main, since a detached worktree's `main` is the source's, still at init.
      git(repo, "push", "-q", "origin", "HEAD:main");
    }
    git(repo, "switch", "-q", "-c", branch);
    if (opts.behind) {
      // Pushed from the source clone, so the workspace clone's origin/main stays stale until a fetch.
      git(source, "fetch", "-q", "origin", "main");
      git(source, "switch", "-q", "--detach", "origin/main");
      for (const n of [1, 2]) git(source, "commit", "-q", "--allow-empty", "-m", `main moved ${n}`);
      git(source, "push", "-q", "origin", "HEAD:main");
    }
    git(source, "switch", "-q", "-c", "fixture-source");
    const held = opts.staleCompose && frag !== undefined;
    if (change) write(path.join(repo, change), opts.changeBranch ?? "changed\n");
    if (frag !== undefined && !held) write(path.join(repo, FRAGMENT_FILE), frag);
    if (change || (frag !== undefined && !held))
      git(
        repo,
        "commit",
        "-q",
        "-am",
        `change ${changed.filter((f) => !held || f !== FRAGMENT_FILE).join(", ")}`,
      );
    if (held)
      applyFragmentChange = () => {
        write(path.join(repo, FRAGMENT_FILE), frag as string);
        git(repo, "commit", "-q", "-am", `change ${FRAGMENT_FILE}`);
      };
    if (opts.prFile && changed.length)
      write(
        path.join(notes, `pr-${name}.md`),
        `---\nrepo: o/${name}\nbranch: ${branch}\nbase: main\nstatus: ${status}\n${extra}---\n# feat: fixture change\n\n${PASS}`,
      );
  }
  if (opts.prFile) write(path.join(notes, "exercise.md"), PASS);
  if (opts.postmortem)
    write(path.join(workspace, "postmortem.md"), "# Post-mortem\n\nseeded by the fixture\n");

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

  const leases: Record<string, { slot: number; workspace: string }> = {};
  if (opts.slotsFull) {
    for (let slot = 1; slot <= YAML.parse(PORTS).feature_slots.count; slot++) {
      const other = path.join(root, "ws", `other-${slot}`);
      fs.mkdirSync(other, { recursive: true });
      leases[`other-${slot}`] = { slot, workspace: other };
    }
  }
  const now = Date.now();
  const queue = (opts.queue ?? []).map((entry, i) => {
    const [feature = entry, waitedMin, services] = QUEUE_ENTRY.exec(entry)?.slice(1) ?? [];
    if (waitedMin === undefined) return feature;
    const ws = path.join(root, "ws", feature);
    const names = services?.split(",");
    // 1 CPU and 1 GiB each, so `budget status` and admission have a cost to show and price.
    const compose = Object.fromEntries(
      (names ?? ["app"]).map((s) => [
        s,
        {
          image: "fixture",
          deploy: { resources: { limits: { cpus: "1" }, reservations: { memory: "1g" } } },
        },
      ]),
    );
    write(path.join(ws, COMPOSE_FILE), YAML.stringify({ services: compose }));
    leases[feature] = { slot: Object.keys(leases).length + 1, workspace: ws };
    write(
      waitingPath(ws),
      JSON.stringify({
        position: i + 1,
        reason: "waiting for capacity",
        ...(names && { services: names }),
        since: new Date(now - Number(waitedMin) * 60_000).toISOString(),
      }),
    );
    return feature;
  });
  // leasesPath() beside configFile: the env that points it here isn't set yet in this process.
  if (Object.keys(leases).length)
    write(path.join(path.dirname(configFile), "scheduler", "leases.json"), JSON.stringify(leases));
  if (opts.queue)
    write(path.join(path.dirname(configFile), "scheduler", "queue.json"), JSON.stringify(queue));
  const containers = (opts.containers ?? []).map((c) => {
    const ws = path.join(root, "ws", c.workspace);
    fs.mkdirSync(ws, { recursive: true });
    return [c.feature, ws, c.startedAt, c.memory, c.nanoCpus, c.execs ?? 0].join("\t");
  });

  fs.mkdirSync(home, { recursive: true });
  const fakes = writeFakes(path.join(root, "bin"), {
    prUrl: `https://github.com/${FIXTURE_REPO_SLUG}/pull/1`,
    running: opts.running ?? [],
    containers,
    prState: opts.merged ? "MERGED" : undefined,
    issue: yml["issue_id"] ? FIXTURE_ISSUE : undefined,
    // shortcut: every exec runs in the first code repo; map container → repo when a fixture has two.
    execCwd: opts.execRuns ? path.join(workspace, (repos[0] as FixtureRepo).name) : undefined,
  });

  return {
    root,
    applyFragmentChange,
    configFile,
    workspace,
    repo: path.join(workspace, (repos[0] as FixtureRepo).name),
    ghLog: fakes.ghLog,
    dockerLog: fakes.dockerLog,
    env: {
      ...GIT_ENV,
      // os.homedir() reads HOME, so tokens, locks and anything else under ~ stay in the fixture.
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      WERKMEISTER_CONFIG_FILE: configFile,
      WERKMEISTER_FIXTURE: "1",
      WERKMEISTER_GH_BIN: fakes.gh,
      WERKMEISTER_DOCKER_BIN: fakes.docker,
      // dockerode honours DOCKER_HOST before any context, so no engine call reaches the host (SW-164).
      // A fixed short path: one under a deep temp root passes macOS's 104-byte socket limit and crashes with EINVAL.
      DOCKER_HOST: "unix:///nonexistent/werkmeister-fixture-docker.sock",
      // jiraCreds() reads these before config; blank, the fixture config's missing `jira:` wins, so
      // only the fake Jira (`jira`) is ever reached.
      JIRA_BASE_URL: opts.jira ?? "",
      JIRA_EMAIL: opts.jira ? "fixture@example.invalid" : "",
      JIRA_API_TOKEN: opts.jira ? "fixture" : "",
      // A fixture step must not act as the caller on Anthropic, a cluster or GitHub (SW-424).
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      KUBECONFIG: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      // Blank, claude and codex are the failing stubs, so the Jira fallback to `claude -p` never
      // reaches the real tracker; a caller's workspace config would aim init at a real issue (SW-911).
      CLAUDE_BIN: opts.claudeBin ?? "",
      CODEX_BIN: opts.codexBin ?? "",
      OPENCODE_BIN: "",
      WERKMEISTER_WORKSPACE_CONFIG: "",
      // Read before sandboxHome(): a caller's would take the fixture's issue briefings.
      WERKMEISTER_CACHE_FILE: "",
      // Dead even when the caller's shell exports the real daemon's address (SW-264, SW-426).
      WERKMEISTER_HOST: opts.daemon ?? closedPortUrl(),
      // A refused daemon is retried for a restart gap (15 s default): each fixture step would wait it out (SW-708).
      WERKMEISTER_DAEMON_RETRY_MS: process.env["WERKMEISTER_DAEMON_RETRY_MS"] || "500",
    },
  };
}

// A port just bound and closed, so a call is refused (ECONNREFUSED) like a stopped daemon: fetch
// rejects port 1 as a "bad port" before connecting (SW-708). Sync, since seedFixture is.
// shortcut: another process can take the port between close and use; hold a socket if that flakes.
function closedPortUrl(): string {
  const port = execFileSync(process.execPath, [
    "-e",
    "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
  ]).toString();
  return `http://127.0.0.1:${port}`;
}

const SCRIPT = `#!/bin/sh
# Generated by \`werkmeister workspace init\` (SW-292); rerun it to regenerate.
# Runs this workspace's own built werkmeister CLI against a seeded fixture workspace, removed on exit:
# temp HOME and registry, a local bare origin, logging fakes for gh and docker, dead Docker and daemon.
# usage: with-fixture-workspace [--no-wait] [--gate] [--bare] [--daemon] [--exec-runs] [--merged] [--behind] [--slots-full] [--postmortem] [--worktrees] [--jira] [--running <file>] [--queue <feature>[,<feature>]... | --queue <feature>:<waitedMin>[:<service>,...]]... [--issue <ref>] [--pr-field <key>=<value>]... [--pr-line '<key>: <value>']... [--workspace <file>] [--config <file>] [--services <file>] [--fragment <file>] [--change <path>] [--change-base <file>] [--change-branch <file>] [--fragment-change <file>] [--stale-compose] [--print <file>]... <werkmeister args> [--then <werkmeister args>]...
# It only ever runs that CLI, never another command, so one allow rule can cover it (SW-172, SW-231);
# --exec-runs, given first, also runs the registry's rows on the host, so the workspace asks before it (SW-473).
ws=$(cd "$(dirname "$0")/../.." && pwd -P) || exit 1
main=
for f in "$ws"/*/apps/cli/dist/main.js; do
  [ -f "$f" ] || continue
  [ -z "$main" ] || { echo "with-fixture-workspace: more than one built CLI under $ws" >&2; exit 2; }
  main=$f
done
[ -n "$main" ] || { echo "with-fixture-workspace: no built CLI at $ws/<worktree>/apps/cli/dist/main.js; build it first" >&2; exit 2; }
# In the werkmeister container the worktree is also at /app, the only place its node_modules volume is mounted (SW-548).
app=/app
wt=\${main%/apps/cli/dist/main.js}
[ ! "$app" -ef "$wt" ] || { wt=$app; main=$app/apps/cli/dist/main.js; }
[ -n "$(ls -A "$wt/node_modules" 2>/dev/null)" ] || { echo "with-fixture-workspace: no node_modules in $wt (installed in the container); run it there: docker exec -w /app <container> $0 ..." >&2; exit 2; }
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
