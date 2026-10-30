/**
 * Workspace PR lifecycle (docs/workspace-lifecycle.md): per-repo PR files, the
 * pre-PR gate, `werkmeister pr open|status`, the lifecycle state the pane shows,
 * and close-out. The PR files are the only state; GitHub and release tags are
 * read on demand and written back into them.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

import { serviceTestCommand } from "./archetypes.js";
import { childEnv } from "./claude_cli.js";
import { COMPOSE_FILE } from "./compose_file.js";
import {
  type ArchetypeRegistry,
  containerOf,
  dotDir,
  IDLE_SERVICE_TYPES,
  loadArchetypes,
  loadReposConfig,
  loadServices,
  type RepoEntry,
  type ReposConfig,
  type ServicesConfig,
  sandboxHome,
} from "./config.js";
import { GATE_COMPOSE_FILE, renderGateCompose } from "./generate.js";
import { updateNoteStatus } from "./graduate.js";
import { type IssueStatuses, issueStatuses, moveIssue } from "./issue_status.js";
import { issueIdOf, issueTracker, projectOf } from "./issue_tracker.js";
import type { IssueTrackerStrategy } from "./issue_trackers/types.js";
import {
  grantWaiters,
  idleStopMinutes,
  lastExecMarker,
  readServicesFromWorkspace,
  startService,
  stop as stopFeature,
  stopIdle,
} from "./lifecycle.js";
import { openDecisions } from "./notes.js";
import { prRulesPath } from "./pr_guard.js";
import { branchRegistry, type MergedRegistry } from "./registry_sync.js";
import {
  commitAndPush,
  listRepoWorktrees,
  listWorkspaces,
  removeWorkspace,
  resolveSessionSource,
  resolveWorkspaceDir,
  sendToClaudeSession,
  sessionStartDir,
  WorkspaceError,
  worktreeSources,
} from "./sandbox.js";
import { portHolders } from "./scheduler_state.js";
import { getServicePort } from "./slots.js";
import { loadConfigFile } from "./workspace_prompts.js";

export type PrStatus =
  | "draft"
  | "approved"
  | "open"
  | "merged"
  | "shipped"
  | "closed"
  | "abandoned";
export type Lifecycle =
  | "working"
  | "ready"
  | "pr-open"
  | "merged"
  | "shipped"
  | "closed-out"
  | "abandoned";

const SETTLED = new Set(["shipped", "closed", "abandoned"]);
const PAST_MERGE = new Set(["merged", "shipped", "closed", "abandoned"]);

export interface PrFile {
  path: string;
  /** The code worktree's directory name — also its key in the registry `repos:`. */
  dir: string;
  /** The file's own name: `werkmeister` for `pr-werkmeister.md`, `werkmeister-why-page` for a follow-up (SW-103). */
  stem: string;
  fm: Record<string, unknown>;
  title: string;
  body: string;
}

export type Run = (
  bin: string,
  args: string[],
  cwd?: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Everything that leaves the process, so tests stub the seam and keep the logic real. */
export interface Deps {
  run: Run;
  /** HTTP status of a GET, or 0 when unreachable. */
  httpStatus: (url: string) => Promise<number>;
  services: ServicesConfig;
  archetypes: ArchetypeRegistry;
  repos: ReposConfig;
  /** Fixed tracker and statuses (tests); absent: the workspace's own, through its project (SW-104). */
  tracker?: IssueTrackerStrategy;
  /** Where each lifecycle point moves the issue (issue_status.ts). */
  statuses?: IssueStatuses;
  /** Commit and push *paths* (relative to the workspace) on the record branch — nothing else that is dirty. */
  commitRecord: (
    ws: string,
    message: string,
    paths: string[],
  ) => Promise<{ ok: boolean; message: string }>;
  /** *abandoned*: don't push a code branch that would hold only the handoff commit (SW-91). */
  remove: (name: string, abandoned: boolean) => Promise<{ output: string }>;
  /** Terminal sessions still open in the workspace, one line each. */
  terminals: (ws: string) => Promise<string[]>;
  sourceOf: (dir: string) => Promise<string | null>;
  /** The PR file's callback fields for the session running `pr open` (#236). */
  session: (ws: string) => Promise<Record<string, string>>;
  /** The registry as built from *worktree*'s own fragment for *repo* (registry_sync.ts), or null. */
  branchRegistry: (repo: string, worktree: string) => MergedRegistry | null;
  /** Stop the workspace's feature containers (SW-39); one line, never throws. */
  stop: (ws: string) => Promise<string>;
  /** One idle-reaper pass over every workspace (SW-39). */
  reapIdle: () => Promise<{ lines: string[] }>;
  /** Start one of the feature's services and wait for it (SW-34); throws on failure. */
  startService: (
    ws: string,
    feature: string,
    service: string,
    composeName?: string,
  ) => Promise<void>;
  /** Write compose.gate.yml from *services*; the services whose compose.yml entry it changes (SW-118). */
  gateCompose: (ws: string, feature: string, services: ServicesConfig) => string[];
  /** Host ports *services* would publish that something else binds (SW-173). */
  portHolders: (
    ws: string,
    feature: string,
    services: string[],
  ) => Promise<{ port: number; holder: string }[]>;
}

// Test suites outlast runCapture's 120 s timeout, which is sized for `claude -p`.
const execRun: Run = (bin, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, env: childEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr) || (err && code === 1 ? err.message : ""),
          code,
        });
      },
    );
  });

async function httpStatus(url: string): Promise<number> {
  try {
    return (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) })).status;
  } catch {
    return 0;
  }
}

export function defaultDeps(): Deps {
  return {
    run: execRun,
    httpStatus,
    services: loadServices(),
    archetypes: loadArchetypes(),
    repos: loadReposConfig(),
    commitRecord: commitAndPush,
    remove: (name, abandoned) =>
      removeWorkspace(name, {
        closedOut: true,
        abandon: abandoned ? "close-out --abandon" : undefined,
      }),
    terminals: (ws) => openTerminalSessions(ws),
    sourceOf: async (dir) => (await worktreeSources([dir]))[0] ?? null,
    session: (ws) => callbackFields(ws, process.env),
    branchRegistry: (repo, worktree) => branchRegistry(repo, worktree),
    stop: stopWorkspace,
    reapIdle: async () => {
      const minutes = idleStopMinutes();
      const { lines } = minutes ? await stopIdle(minutes) : { lines: [] };
      // The tick is the wake-up for a queue no stop has drained (SW-181).
      const granted = await grantWaiters().catch((e: Error) => [`waiting queue: ${e.message}`]);
      return { lines: [...lines, ...granted.map((f) => `${f}: started from the waiting queue`)] };
    },
    startService: (ws, feature, service, composeName) =>
      startService(feature, ws, service, composeName),
    portHolders: (ws, feature, services) => portHolders(feature, ws, services),
    gateCompose: (ws, feature, services) =>
      renderGateCompose(
        feature,
        Number(readEnv(ws, "WERKMEISTER_SLOT")),
        readServicesFromWorkspace(ws),
        services,
        ws,
      ),
  };
}

/** The tracker and statuses that move *ref*, the issue of the workspace whose config is *cfg*. */
function trackingOf(
  cfg: Record<string, unknown> | null,
  ref: string,
  deps: Deps,
): { tracker: IssueTrackerStrategy; statuses: IssueStatuses } {
  const at = { project: projectOf(cfg), text: ref };
  return {
    tracker: deps.tracker ?? issueTracker(at),
    statuses: deps.statuses ?? issueStatuses(at),
  };
}

/** Stop *ws*'s feature containers, keeping slot and volumes (SW-39). */
async function stopWorkspace(ws: string): Promise<string> {
  const feature = readEnv(ws, "FEATURE");
  if (!feature) return "containers already stopped";
  try {
    await stopFeature(feature);
    return "containers stopped (slot and volumes kept; `werkmeister up` resumes)";
  } catch (e) {
    if ((e as { code?: string }).code === "NOT_RUNNING") return "containers already stopped";
    return `could not stop containers — ${(e as Error).message}`;
  }
}

/** Record that the gate is about to `docker exec`, so the idle reaper keeps the containers. */
function touchExecMarker(ws: string): void {
  try {
    fs.writeFileSync(lastExecMarker(ws), "");
  } catch {
    // a missing dot-dir must not fail the gate
  }
}

// ---- PR files --------------------------------------------------------------

/**
 * Where PR files live: the propose stage's output (ICM), else `.werkmeister/notes`
 * (JIT). `_ship` is the stage name before decision 11. A template with neither
 * (spike) keeps them in its last stage's output (SW-83); null only when
 * `stages/` holds no stage.
 */
export function prFileDir(ws: string): string | null {
  let names: string[];
  try {
    names = fs
      .readdirSync(path.join(ws, "stages"))
      .filter((n) => /^\d+_/.test(n))
      .sort();
  } catch {
    return path.join(dotDir(ws), "notes");
  }
  const dir =
    names.find((n) => /^\d+_propose$/.test(n)) ??
    names.find((n) => /^\d+_ship$/.test(n)) ??
    names.at(-1);
  return dir ? path.join(ws, "stages", dir, "output") : null;
}

function parsePrFile(p: string): PrFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(fs.readFileSync(p, "utf8"));
  let fm: unknown = null;
  let yamlError = "";
  try {
    fm = m ? YAML.parse(m[1]) : null;
  } catch (e) {
    yamlError = ` YAML error: ${(e as Error).message}`;
  }
  if (!m || typeof fm !== "object" || fm === null || Array.isArray(fm)) {
    throw new WorkspaceError(
      `${p}: PR file needs YAML frontmatter between --- lines (see pr-rules.md).${yamlError}`,
    );
  }
  const heading = /^#\s+(.+)$/m.exec(m[2]);
  const stem = path.basename(p).replace(/^pr-/, "").replace(/\.md$/, "");
  const worktree = (fm as Record<string, unknown>)["worktree"];
  return {
    path: p,
    // A follow-up's name carries a slug, so its worktree comes from frontmatter (SW-103).
    dir: typeof worktree === "string" && worktree.trim() ? worktree.trim() : stem,
    stem,
    fm: fm as Record<string, unknown>,
    title: heading ? heading[1].trim() : "",
    body: heading ? m[2].slice(heading.index + heading[0].length).replace(/^\s*\n/, "") : m[2],
  };
}

export function readPrFiles(ws: string): PrFile[] {
  const dir = prFileDir(ws);
  if (!dir) return [];
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^pr-.+\.md$/.test(n))
      .sort();
  } catch {
    /* no dir yet — no PR files */
  }
  return names.map((n) => parsePrFile(path.join(dir, n)));
}

/** An `undefined` field is removed from the frontmatter. */
export function writePrFields(file: PrFile, fields: Record<string, string | undefined>): void {
  updateNoteStatus(file.path, fields);
  Object.assign(file.fm, fields);
}

const statusOf = (f: PrFile): string => String(f.fm["status"] ?? "draft").trim();
const reason = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ---- Gate ------------------------------------------------------------------

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface GateResult {
  ok: boolean;
  checks: GateCheck[];
}

const PASS_CELL = /\|\s*PASS\s*\|/;
const FAIL_CELL = /\|\s*FAIL\s*\|/;

const CELL_FORMAT =
  "each row needs a result cell that is exactly `PASS` or `FAIL`, evidence in its own column: `| criterion | PASS | evidence |`";

function passTable(text: string): string | null {
  if (FAIL_CELL.test(text)) return "has a FAIL row";
  if (!PASS_CELL.test(text)) return `has no PASS row — ${CELL_FORMAT}`;
  return null;
}

function stagesCheck(ws: string): GateCheck {
  const prDir = prFileDir(ws);
  if (!fs.existsSync(path.join(ws, "stages"))) {
    const open = openDecisions(ws).map((n) => path.basename(n.path));
    return {
      name: "stages",
      ok: open.length === 0,
      detail: open.length ? `open decision notes: ${open.join(", ")}` : "no open decisions",
    };
  }
  const own = prDir ? path.basename(path.dirname(prDir)) : "";
  const empty = fs
    .readdirSync(path.join(ws, "stages"))
    .sort()
    .filter((d) => d < own)
    .filter((d) => {
      try {
        return !fs
          .readdirSync(path.join(ws, "stages", d, "output"))
          .some((f) => !f.startsWith("."));
      } catch {
        return true;
      }
    });
  return {
    name: "stages",
    ok: empty.length === 0,
    detail: empty.length ? `no output yet: ${empty.join(", ")}` : "every earlier stage has output",
  };
}

function exerciseFile(ws: string): string | null {
  if (!fs.existsSync(path.join(ws, "stages"))) {
    const p = path.join(dotDir(ws), "notes", "exercise.md");
    return fs.existsSync(p) ? p : null;
  }
  // `verify.md` is the name before decision 11.
  for (const name of ["exercise.md", "verify.md"]) {
    for (const d of fs.readdirSync(path.join(ws, "stages")).sort()) {
      const p = path.join(ws, "stages", d, "output", name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Services whose files the branch changed, by longest prefix among `path_mappings` and
 * `no_service_paths` (which touch nothing, e.g. docs); any other file touches the whole repo.
 */
export function mapTouched(files: string[], repo: RepoEntry): string[] {
  const mappings: [string, string | null][] = [
    ...Object.entries((repo["path_mappings"] ?? {}) as Record<string, string>),
    ...((repo["no_service_paths"] ?? []) as string[]).map((p): [string, null] => [
      p.replace(/\/+$/, ""),
      null,
    ]),
  ];
  const out = new Set<string>();
  for (const f of files) {
    const hit = mappings
      .filter(([p]) => f === p || f.startsWith(p + "/"))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (hit) {
      if (hit[1] !== null) out.add(hit[1]);
    } else for (const s of (repo["services"] ?? []) as string[]) out.add(s);
  }
  return [...out].sort();
}

function readEnv(ws: string, key: string): string {
  try {
    for (const line of fs.readFileSync(path.join(ws, ".env"), "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
    }
  } catch {
    /* no .env */
  }
  return "";
}

/**
 * The pre-PR gate for one repo. A container it had to start for the repo's
 * tests is stopped again, pass or fail; what was running before stays (SW-34).
 * One it recreated from the branch's settings is recreated from compose.yml (SW-118).
 */
export async function runGate(
  ws: string,
  file: PrFile,
  deps: Deps = defaultDeps(),
): Promise<GateResult> {
  const started: string[] = [];
  const recreated: string[] = [];
  let result!: GateResult;
  try {
    result = await gateChecks(ws, file, deps, started, recreated);
  } finally {
    fs.rmSync(path.join(ws, GATE_COMPOSE_FILE), { force: true });
    const feature = String(loadConfigFile(ws, null)["feature"] ?? readEnv(ws, "FEATURE")).trim();
    for (const svc of recreated) {
      let detail = `recreated ${svc} from the branch's container settings for the gate, then from ${COMPOSE_FILE} again`;
      try {
        await deps.startService(ws, feature, svc);
      } catch (e) {
        detail = `recreated ${svc} from the branch's container settings for the gate; could not restore it from ${COMPOSE_FILE} — ${e instanceof Error ? e.message : String(e)}`;
      }
      result?.checks.push({ name: "containers", ok: true, detail });
    }
    if (started.length) {
      const stop = await deps.run("docker", ["stop", ...started]);
      result?.checks.push({
        name: "containers",
        ok: true,
        detail: stop.code
          ? `started ${started.join(", ")}; could not stop — ${stop.stderr.trim()}`
          : `started ${started.join(", ")} for the gate, stopped again`,
      });
    }
  }
  return result;
}

async function gateChecks(
  ws: string,
  file: PrFile,
  deps: Deps,
  started: string[],
  recreated: string[],
): Promise<GateResult> {
  const checks: GateCheck[] = [stagesCheck(ws)];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const table = passTable(file.body);
  add("acceptance", table === null, table ? `PR file ${table}` : "all PASS");
  add("approved", statusOf(file) === "approved", `status: ${statusOf(file)}`);
  // The PR-file checks are instant; the test commands can take ten minutes cold (SW-150).
  if (checks.some((c) => !c.ok)) {
    add("tests", false, "not run — fix the PR-file checks above first");
    return { ok: false, checks };
  }

  const dir = path.join(ws, file.dir);
  const status = await deps.run("git", ["-C", dir, "status", "--porcelain"]);
  add(
    "clean",
    status.code === 0 && status.stdout.trim() === "",
    status.code
      ? status.stderr.trim()
      : status.stdout.trim()
        ? `uncommitted:\n${status.stdout.trimEnd()}`
        : "clean",
  );

  // The shared registry holds main's fragment; a branch that renames packages
  // must be tested with its own `test:` filters and path mappings (SW-25).
  let services = deps.services;
  let repo = deps.repos[file.dir] ?? {};
  let own: MergedRegistry | null = null;
  try {
    own = deps.branchRegistry(file.dir, dir);
    if (own) {
      services = own.services;
      repo = own.repos[file.dir] ?? {};
    }
  } catch (e) {
    add("registry", false, `branch fragment: ${e instanceof Error ? e.message : String(e)}`);
  }

  const cfg = loadConfigFile(ws, null);
  const feature = String(cfg["feature"] ?? readEnv(ws, "FEATURE")).trim();
  const local = new Set(
    String(cfg["services"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const ps = await deps.run("docker", ["ps", "--format", "{{.Names}}"]);
  const running = new Set(
    ps.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // compose.yml is rendered from the machine registry, which can still carry ids the
  // branch has renamed (SW-87); containers and on-demand starts use its ids.
  const machineRepo = deps.repos[file.dir] ?? {};
  const rendered = (machineRepo["services"] ?? []) as string[];
  const containerFor = (svc: string): string | null => {
    const own = containerOf(feature, svc);
    if (running.has(own)) return own;
    // Every container of a repo mounts the same worktree at /app with its node_modules.
    const sibling = [...((repo["services"] ?? []) as string[]), ...rendered]
      .map((s) => containerOf(feature, s))
      .find((c) => running.has(c));
    return sibling ?? null;
  };

  // Fails before any test runs: a start that hits a bound port fails ten minutes late otherwise (SW-173).
  const portsFree = async (svcs: string[]): Promise<boolean> => {
    const clash = svcs.length ? await deps.portHolders(ws, feature, svcs) : [];
    if (!clash.length) return true;
    add(
      "ports",
      false,
      `${clash.map((c) => `port ${c.port} held by ${c.holder}`).join("; ")} — free them, then rerun`,
    );
    add("tests", false, "not run — a port this workspace starts on is taken");
    return false;
  };

  const base = String(file.fm["base"] ?? "main");
  const diff = await deps.run("git", ["-C", dir, "diff", "--name-only", `origin/${base}...HEAD`]);
  if (diff.code !== 0) {
    add("tests", false, `cannot diff against origin/${base}: ${diff.stderr.trim()}`);
  }
  const touched = diff.code === 0 ? mapTouched(diff.stdout.split("\n").filter(Boolean), repo) : [];
  const skips = (file.fm["skip_tests"] ?? {}) as Record<string, unknown>;
  const releaseRuns =
    repo["ship"] === "tag" && Boolean(repo["release_check"]) && !reason(file.fm["skip_release"]);

  // Running containers come from compose.yml, rendered from the machine registry; a
  // touched service whose branch settings render differently runs from compose.gate.yml (SW-118).
  if (own) {
    let changed: string[] = [];
    try {
      changed = deps.gateCompose(ws, feature, services).filter((s) => touched.includes(s));
    } catch (e) {
      add("containers", false, `branch compose: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!(await portsFree(changed))) return { ok: false, checks };
    for (const svc of changed) {
      const container = containerOf(feature, svc);
      const wasRunning = running.has(container);
      // Before the start: a recreate that fails halfway still needs compose.yml's container back.
      if (wasRunning) recreated.push(svc);
      touchExecMarker(ws);
      try {
        await deps.startService(ws, feature, svc, GATE_COMPOSE_FILE);
        if (!wasRunning) started.push(container);
        running.add(container);
      } catch (e) {
        add(
          `start ${svc}`,
          false,
          `with the branch's container settings: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  const repoServices = (repo["services"] ?? []) as string[];
  const needsContainer =
    releaseRuns ||
    Boolean(repo["lint"]) ||
    touched.some((s) => !reason(skips[s]) && serviceTestCommand(s, services[s], deps.archetypes));
  if (needsContainer && !repoServices.some(containerFor)) {
    // A branch id maps to the compose id that owns the same path.
    const toRendered = (s: string): string | undefined => {
      if (rendered.includes(s)) return s;
      const at = Object.entries((repo["path_mappings"] ?? {}) as Record<string, string>).find(
        ([, name]) => name === s,
      )?.[0];
      return at === undefined
        ? undefined
        : ((machineRepo["path_mappings"] ?? {}) as Record<string, string>)[at];
    };
    const renamed = touched.filter((s) => toRendered(s) && toRendered(s) !== s);
    if (renamed.length)
      add(
        "registry",
        true,
        `compose.yml still names ${renamed.map((s) => `${s} as ${toRendered(s)}`).join(", ")} — ` +
          "resync the machine registry with `werkmeister registry`",
      );
    const candidates = [
      ...touched.map(toRendered).filter((s): s is string => Boolean(s)),
      ...rendered,
    ];
    // Any one container serves the whole repo (containerFor's sibling fallback); an
    // idle one only sleeps, where a web service would start its dev server.
    const pick =
      candidates.find((s) => IDLE_SERVICE_TYPES.includes(deps.services[s]?.["type"] ?? "")) ??
      candidates[0];
    if (pick && !(await portsFree([pick]))) return { ok: false, checks };
    if (pick) {
      touchExecMarker(ws);
      try {
        await deps.startService(ws, feature, pick);
        running.add(containerOf(feature, pick));
        started.push(containerOf(feature, pick));
      } catch (e) {
        add(`start ${pick}`, false, e instanceof Error ? e.message : String(e));
      }
    }
  }

  const repoContainer = () =>
    touched.map(containerFor).find(Boolean) ?? containerFor(repoServices[0] ?? "");
  if (repo["lint"]) {
    const container = repoContainer();
    if (!container) add("lint", false, "no running container for this repo — run `werkmeister up`");
    else {
      touchExecMarker(ws);
      const res = await deps.run("docker", ["exec", container, "sh", "-c", repo["lint"]]);
      add(
        "lint",
        res.code === 0,
        `${repo["lint"]} → exit ${res.code}${res.code ? `\n${(res.stdout + res.stderr).trimEnd().split("\n").slice(-15).join("\n")}` : ""}`,
      );
    }
  }

  for (const svc of touched) {
    const cmd = serviceTestCommand(svc, services[svc], deps.archetypes);
    const why = reason(skips[svc]);
    if (!cmd) {
      add(
        `test ${svc}`,
        Boolean(why),
        why
          ? `skipped: ${why}`
          : "no test command registered — add `test:` to its registry entry, or `skip_tests: { " +
              svc +
              ": <reason> }`",
      );
      continue;
    }
    const container = containerFor(svc);
    if (!container) {
      add(
        `test ${svc}`,
        Boolean(why),
        why ? `skipped: ${why}` : "no running container for this repo — run `werkmeister up`",
      );
      continue;
    }
    touchExecMarker(ws);
    const res = await deps.run("docker", ["exec", container, "sh", "-c", cmd]);
    add(
      `test ${svc}`,
      res.code === 0,
      `${cmd} → exit ${res.code}${res.code ? `\n${(res.stdout + res.stderr).trimEnd().split("\n").slice(-15).join("\n")}` : ""}`,
    );
  }

  const skipExercise = reason(file.fm["skip_exercise"]);
  if (skipExercise) add("exercise", true, `skipped: ${skipExercise}`);
  else {
    const evidence = exerciseFile(ws);
    const evidenceProblem = evidence ? passTable(fs.readFileSync(evidence, "utf8")) : "is missing";
    add(
      "exercise",
      evidenceProblem === null,
      evidence
        ? `${path.relative(ws, evidence)} ${evidenceProblem ?? "all PASS"}`
        : "no exercise.md — record the exercise checks first",
    );
  }
  const slot = Number(readEnv(ws, "WERKMEISTER_SLOT"));
  // Only a served endpoint has a baseline; the test check already proved a container ran the rest.
  const isServed = (s: string) => ["api", "web"].includes(services[s]?.["type"] ?? "");
  for (const svc of touched.filter((s) => local.has(s) && isServed(s))) {
    const def = services[svc] ?? {};
    if (!running.has(containerOf(feature, svc))) {
      add(`baseline ${svc}`, false, "container not running — run `werkmeister up`");
      continue;
    }
    const url = `http://localhost:${getServicePort(slot, def["port_offset"] ?? 0)}${def["health_endpoint"] ?? "/"}`;
    const code = await deps.httpStatus(url);
    add(`baseline ${svc}`, code > 0 && code < 400, `GET ${url} → ${code || "unreachable"}`);
  }

  if (repo["ship"] === "tag" && repo["release_check"]) {
    const why = reason(file.fm["skip_release"]);
    const container = repoContainer();
    if (why) add("release", true, `skipped: ${why}`);
    else if (!container)
      add("release", false, "no running container for this repo — run `werkmeister up`");
    else {
      touchExecMarker(ws);
      const res = await deps.run("docker", ["exec", container, "sh", "-c", repo["release_check"]]);
      add(
        "release",
        res.code === 0,
        `${repo["release_check"]} → exit ${res.code}${res.code ? `\n${(res.stdout + res.stderr).trimEnd().split("\n").slice(-5).join("\n")}` : ""}`,
      );
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatGate(dir: string, g: GateResult): string[] {
  return [
    `${dir}: gate ${g.ok ? "passed" : "FAILED"}`,
    ...g.checks.map(
      (c) => `  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail.replace(/\n/g, "\n      ")}`,
    ),
  ];
}

// ---- open / status ---------------------------------------------------------

export async function gatePrs(
  ws: string,
  only?: string,
  deps: Deps = defaultDeps(),
): Promise<{ ok: boolean; lines: string[] }> {
  const all = readPrFiles(ws);
  const files = selectFiles(ws, all, only, (f) => !superseded(f, all));
  const lines: string[] = [];
  let ok = true;
  for (const f of files) {
    const g = await runGate(ws, f, deps);
    ok &&= g.ok;
    lines.push(...formatGate(f.stem, g));
  }
  return { ok, lines };
}

/** A merged PR whose worktree has since moved on to a follow-up PR file. */
function superseded(f: PrFile, all: PrFile[]): boolean {
  return (
    PAST_MERGE.has(statusOf(f)) &&
    all.some((g) => g !== f && g.dir === f.dir && !PAST_MERGE.has(statusOf(g)))
  );
}

/** *only* names a file stem or a worktree; a worktree with several files narrows them by *keep*. */
function selectFiles(
  ws: string,
  all: PrFile[],
  only: string | undefined,
  keep: (f: PrFile) => boolean,
): PrFile[] {
  let found = all;
  let files = all.filter(keep);
  if (only) {
    found = files = all.filter((f) => f.stem === only || f.dir === only);
    if (files.length > 1) files = files.filter(keep);
  }
  if (!files.length) {
    // Files exist but none qualify: name each one's status, not "write a file" (SW-199).
    if (found.length)
      throw new WorkspaceError(
        found
          .map(
            (f) =>
              `${path.basename(f.path)} is at status: ${statusOf(f)}; set status: approved to open it.`,
          )
          .join("\n"),
      );
    const where = prFileDir(ws) ?? "this workspace (no stage holds PR files)";
    const format = `format: ${prRulesPath(ws)}`;
    throw new WorkspaceError(
      only
        ? `No PR file for ${only} in ${where} (${format}).`
        : `No matching PR file in ${where}. Write pr-<worktree>[-<slug>].md there (${format}) and have the person set status: approved.`,
    );
  }
  return files;
}

export async function openPrs(
  ws: string,
  only?: string,
  deps: Deps = defaultDeps(),
): Promise<{ ok: boolean; lines: string[] }> {
  const all = readPrFiles(ws);
  const files = selectFiles(ws, all, only, (f) => statusOf(f) === "approved");
  const lines: string[] = [];
  let ok = true;
  const opened: string[] = [];
  for (const f of files) {
    const branch = String(f.fm["branch"] ?? "");
    // GitHub deletes a merged PR's branch; pushing the same name again recreates it (SW-98).
    const used = all.find(
      (g) =>
        g !== f &&
        g.dir === f.dir &&
        String(g.fm["branch"] ?? "") === branch &&
        ["merged", "shipped", "closed"].includes(statusOf(g)),
    );
    if (used) {
      ok = false;
      lines.push(
        `${f.stem}: branch ${branch} was already used by ${used.stem} (${statusOf(used)}) — cut a new one with \`werkmeister pr new ${f.dir} --slug <slug>\``,
      );
      continue;
    }
    const g = await runGate(ws, f, deps);
    if (!g.ok) {
      ok = false;
      lines.push(...formatGate(f.stem, g));
      continue;
    }
    const dir = path.join(ws, f.dir);
    const push = await deps.run("git", ["-C", dir, "push", "-u", "origin", branch]);
    if (push.code !== 0) {
      ok = false;
      lines.push(`${f.stem}: push failed — ${push.stderr.trim()}`);
      continue;
    }
    const existing = await deps.run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        f.fm["repo"] as string,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url // empty",
      ],
      dir,
    );
    let url = existing.code === 0 ? existing.stdout.trim() : "";
    if (!url) {
      const bodyFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-pr-")),
        "body.md",
      );
      fs.writeFileSync(bodyFile, f.body);
      const created = await deps.run(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          f.fm["repo"] as string,
          "--base",
          String(f.fm["base"] ?? "main"),
          "--head",
          branch,
          "--title",
          f.title,
          "--body-file",
          bodyFile,
        ],
        dir,
      );
      fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
      url = created.stdout.trim().split("\n").pop() ?? "";
      if (created.code !== 0 || !url.startsWith("http")) {
        ok = false;
        lines.push(
          `${f.stem}: gh pr create failed — ${created.stderr.trim() || created.stdout.trim()}`,
        );
        continue;
      }
    }
    writePrFields(f, { status: "open", url, ...(await deps.session(ws)) });
    opened.push(path.relative(ws, f.path));
    lines.push(`${f.stem}: open ${url}`);
    // The desktop app binds a PR, and lets the session turn on Auto-fix, only for a URL the session reports in this tag.
    lines.push(`<pr-created>${url}</pr-created>`);
    // Squash and rebase rewrite SHAs, so a blame-ignore entry added here would match nothing on base.
    const ignored = await deps.run("git", [
      "-C",
      dir,
      "diff",
      `origin/${String(f.fm["base"] ?? "main")}...HEAD`,
      "--",
      ".git-blame-ignore-revs",
    ]);
    if (/^\+[0-9a-f]{7,40}\b/m.test(ignored.stdout))
      lines.push(
        "  warning: this branch adds a SHA to .git-blame-ignore-revs — merge with a merge commit, not squash or rebase, and say so at the top of the PR body",
      );
    const wsCfg = loadConfigFile(ws, null);
    const ref = issueIdOf(wsCfg);
    if (ref) {
      // A follow-up can open after the issue is Done; Done stays, the comment links the fix.
      const followUp = all.some((g) => g !== f && g.dir === f.dir);
      const { tracker, statuses } = trackingOf(wsCfg, ref, deps);
      const moved = await moveIssue(tracker, ref, "in_review", statuses, {
        comment: `${followUp ? "Follow-up PR" : "PR"} opened: ${url}`,
        ...(followUp ? { alwaysComment: true } : {}),
      });
      if (moved) lines.push(`  issue ${moved}`);
    }
  }
  if (opened.length)
    lines.push((await deps.commitRecord(ws, "chore: record opened PR(s)", opened)).message);
  // A failed file still needs the containers to be fixed and re-gated.
  if (ok && opened.length) lines.push(await deps.stop(ws));
  return { ok, lines };
}

export async function refreshPrStatus(
  ws: string,
  deps: Deps = defaultDeps(),
  // `gh: false` is check-in's sweep (SW-65): open → merged stays with `gh` in `pr status`.
  opts: { gh?: boolean } = {},
): Promise<{ lines: string[]; changed: boolean }> {
  const lines: string[] = [];
  const changed: string[] = [];
  // What this pass saw, by PR URL; it picks at most one issue move after the loop.
  const seen = {
    shipped: [] as PrFile[],
    merged: [] as string[],
    closed: [] as string[],
    changesRequested: [] as string[],
    reReview: [] as string[],
  };
  for (const f of readPrFiles(ws)) {
    const before = statusOf(f);
    const reviewBefore = f.fm["review"];
    if (opts.gh !== false && before === "open" && f.fm["url"]) {
      const v = await deps.run("gh", [
        "pr",
        "view",
        String(f.fm["url"]),
        "--json",
        "state,mergeCommit,reviewDecision,latestReviews",
      ]);
      if (v.code !== 0) {
        lines.push(`${f.stem}: gh pr view failed — ${v.stderr.trim()}`);
        continue;
      }
      const view = JSON.parse(v.stdout) as {
        state?: string;
        mergeCommit?: { oid?: string } | null;
        reviewDecision?: string;
        latestReviews?: Array<{ state?: string }>;
      };
      // reviewDecision stays empty on a repo that requires no review; latestReviews still says it.
      const changesRequested =
        view.reviewDecision === "CHANGES_REQUESTED" ||
        (view.latestReviews ?? []).some((r) => r.state === "CHANGES_REQUESTED");
      const url = String(f.fm["url"]);
      if (view.state === "MERGED") {
        writePrFields(f, { status: "merged", merge_sha: view.mergeCommit?.oid ?? "" });
        seen.merged.push(url);
      } else if (view.state === "CLOSED") {
        writePrFields(f, {
          status: "closed",
          reason: reason(f.fm["reason"]) || "closed on GitHub",
        });
        seen.closed.push(url);
      } else if (changesRequested) {
        // `review` records the decision already acted on, so the move fires once per change.
        if (reviewBefore !== "changes_requested") {
          writePrFields(f, { review: "changes_requested" });
          seen.changesRequested.push(url);
        }
      } else if (reviewBefore === "changes_requested") {
        writePrFields(f, { review: undefined });
        seen.reReview.push(url);
      }
    }
    if (statusOf(f) === "merged") {
      const repo = deps.repos[f.dir] ?? {};
      // skip_release only skips the gate's release check; a ship: tag repo still ships with its tag (#145).
      if (repo["ship"] !== "tag") {
        writePrFields(f, { status: "shipped" });
      } else {
        const dir = path.join(ws, f.dir);
        await deps.run("git", ["-C", dir, "fetch", "-q", "--tags", "origin"]);
        const tags = await deps.run("git", [
          "-C",
          dir,
          "tag",
          "--contains",
          String(f.fm["merge_sha"]),
          "--list",
          String(repo["release_tag"]),
          "--sort=creatordate",
        ]);
        const tag =
          tags.code === 0
            ? tags.stdout
                .split("\n")
                .map((t) => t.trim())
                .find(Boolean)
            : undefined;
        if (tag) writePrFields(f, { status: "shipped", release: tag });
      }
    }
    const after = statusOf(f);
    if (after === "shipped" && before !== "shipped") seen.shipped.push(f);
    if (after !== before || f.fm["review"] !== reviewBefore)
      changed.push(path.relative(ws, f.path));
    lines.push(
      `${f.stem}: ${after}${f.fm["release"] ? ` (${f.fm["release"]})` : ""}${f.fm["url"] ? ` ${f.fm["url"]}` : ""}`,
    );
  }
  const moved = await moveIssueForPrs(ws, seen, deps);
  if (moved) lines.push(`issue ${moved}`);
  if (seen.merged.length || seen.shipped.length) lines.push(await deps.stop(ws));
  if (changed.length)
    lines.push((await deps.commitRecord(ws, "chore: record PR status", changed)).message);
  return { lines, changed: changed.length > 0 };
}

const shippedComment = (files: PrFile[]): string =>
  `Shipped: ${files.map((f) => `${f.fm["release"] ?? "merge"} — ${f.fm["url"]}`).join("; ") || "no PRs"}`;

/** The one issue move a `pr status` pass owes, first rule that holds; "" when none. */
async function moveIssueForPrs(
  ws: string,
  seen: {
    shipped: PrFile[];
    merged: string[];
    closed: string[];
    changesRequested: string[];
    reReview: string[];
  },
  deps: Deps,
): Promise<string> {
  const anything = Object.values(seen).some((v) => v.length);
  const wsCfg = anything ? loadConfigFile(ws, null) : null;
  const ref = issueIdOf(wsCfg);
  if (!ref) return "";
  const files = readPrFiles(ws);
  const state = lifecycleOf(ws).state;
  const { tracker, statuses } = trackingOf(wsCfg, ref, deps);
  const move = (point: Parameters<typeof moveIssue>[2], comment: string, back = false) =>
    moveIssue(tracker, ref, point, statuses, { comment, back });
  // A multi-repo workspace is done only when every PR has settled.
  if (seen.shipped.length && state === "shipped")
    return move("done", shippedComment(files.filter((f) => statusOf(f) === "shipped")));
  if (seen.merged.length && files.every((f) => PAST_MERGE.has(statusOf(f))))
    return move("merged", `Merged: ${seen.merged.join(", ")}`);
  if (seen.changesRequested.length)
    return move("in_progress", `Changes requested: ${seen.changesRequested.join(", ")}`, true);
  if (seen.closed.length && !files.some((f) => statusOf(f) === "open"))
    return move("in_progress", `PR closed without merging: ${seen.closed.join(", ")}`, true);
  if (seen.reReview.length) return move("in_review", `Back in review: ${seen.reReview.join(", ")}`);
  return "";
}

// ---- PR callbacks (#236) ---------------------------------------------------
// `pr open` writes `session` (and `host_session` inside the desktop app) into the PR file;
// a watch pass tells that session once per status change, tracked by `notified`.

/** One message owed to the session that opened a PR. */
export interface PrCallback {
  ws: string;
  dir: string;
  url: string;
  session: string;
  /** The folder the session started in, which `--resume` needs; null in callbacks from before SW-16. */
  sessionDir: string | null;
  /** The desktop app's `local_…` id: delivered by the werkmeister mod, never headless. */
  hostSession: string | null;
  message: string;
}

const LOCK_STALE_MS = 15 * 60_000;

/**
 * Claude Code exports both ids to every Bash command, so the session running `pr open`
 * names itself; a person typing it in a plain shell gets the workspace's newest session.
 */
export async function callbackFields(
  ws: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const session =
    env["CLAUDE_CODE_SESSION_ID"] ||
    (await resolveSessionSource(path.basename(ws)).catch(() => null))?.sessionId;
  if (!session) return {};
  const host = env["CLAUDE_CODE_HOST_SESSION_ID"];
  const cwd = await sessionStartDir(session);
  return { session, ...(host && { host_session: host }), ...(cwd && { session_cwd: cwd }) };
}

export function callbackMessage(status: string, url: string, release?: string): string | null {
  if (status === "merged")
    return `PR ${url} merged. Run \`werkmeister pr status\`, then follow the workspace router.`;
  if (status === "shipped")
    return `PR ${url} shipped${release ? ` in ${release}` : ""}. Ask the person whether to run \`werkmeister close-out\`.`;
  if (status === "closed") return `PR ${url} was closed. Report it to the person.`;
  return null;
}

function takeLock(file: string): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        // A pass that died holding it would block every later one.
        if (Date.now() - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return false;
        fs.rmSync(file, { force: true });
      } catch {
        /* released meanwhile: try again */
      }
    }
  }
  return false;
}

/**
 * Refresh every workspace's callback PRs and claim the messages their status changes owe.
 * The claim (`notified`, or dropping the callback once settled) is written before delivery,
 * so a failed delivery is lost rather than sent twice. Without `desktop`, callbacks with a
 * `host_session` are left for the mod, which alone can reach the desktop app.
 */
export async function claimCallbacks(
  workspaces: string[],
  opts: { desktop: boolean },
  deps: Deps = defaultDeps(),
  lockFile = path.join(sandboxHome(), "pr-callbacks.lock"),
): Promise<{ claimed: PrCallback[]; lines: string[] }> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!takeLock(lockFile)) return { claimed: [], lines: ["another PR watch pass is running"] };
  const claimed: PrCallback[] = [];
  const lines: string[] = [];
  try {
    for (const ws of workspaces) {
      const callbacks = () => {
        try {
          return readPrFiles(ws).filter(
            (f) => f.fm["session"] && (opts.desktop || !f.fm["host_session"]),
          );
        } catch {
          return []; // a malformed PR file: the gate and `pr status` report it
        }
      };
      const before = callbacks();
      if (!before.length) continue;
      if (before.some((f) => statusOf(f) === "open" || statusOf(f) === "merged"))
        for (const l of (await refreshPrStatus(ws, deps)).lines)
          lines.push(`${path.basename(ws)}/${l}`);
      const changed: string[] = [];
      for (const f of callbacks()) {
        const status = statusOf(f);
        if (status === (reason(f.fm["notified"]) || "open")) continue;
        const url = String(f.fm["url"] ?? "");
        const message = callbackMessage(status, url, reason(f.fm["release"]) || undefined);
        if (message)
          claimed.push({
            ws,
            dir: f.dir,
            url,
            session: String(f.fm["session"]),
            sessionDir: reason(f.fm["session_cwd"]) || null,
            hostSession: reason(f.fm["host_session"]) || null,
            message,
          });
        writePrFields(
          f,
          SETTLED.has(status)
            ? {
                session: undefined,
                session_cwd: undefined,
                host_session: undefined,
                notified: undefined,
              }
            : { notified: status },
        );
        changed.push(path.relative(ws, f.path));
      }
      if (changed.length)
        lines.push((await deps.commitRecord(ws, "chore: record PR callback", changed)).message);
    }
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
  return { claimed, lines };
}

/**
 * Check-in's freshness pass (SW-65): ship merged PR files by `pr status`'s release-tag rule,
 * without `gh`. Skipped while a callback pass holds the lock — it is refreshing them already.
 */
export async function shipMerged(
  workspaces: string[],
  deps?: Deps,
  lockFile = path.join(sandboxHome(), "pr-callbacks.lock"),
): Promise<string[]> {
  const due = workspaces.filter((ws) => {
    try {
      return readPrFiles(ws).some((f) => statusOf(f) === "merged");
    } catch {
      return false; // a malformed PR file: the gate and `pr status` report it
    }
  });
  if (!due.length) return [];
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!takeLock(lockFile)) return ["another PR watch pass is running"];
  const lines: string[] = [];
  try {
    const d = deps ?? defaultDeps();
    for (const ws of due)
      for (const l of (await refreshPrStatus(ws, d, { gh: false })).lines)
        lines.push(`${path.basename(ws)}/${l}`);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
  return lines;
}

/** Resume a terminal session headlessly with its message. */
export async function deliverHeadless(cb: PrCallback): Promise<void> {
  const name = path.basename(cb.ws);
  const dir = cb.sessionDir ?? (await sessionStartDir(cb.session)) ?? cb.ws;
  // sendToClaudeSession falls back to the newest session for an unknown id; a callback reaches its own or none.
  if ((await resolveSessionSource(name, cb.session, dir)).sessionId !== cb.session)
    throw new WorkspaceError(`session ${cb.session} is gone`);
  await sendToClaudeSession(name, cb.message, cb.session, dir);
}

/**
 * `werkmeister pr watch` (desktop: false) and the werkmeister mod's timer (desktop: true): one
 * pass over every workspace. Headless claims are delivered here; desktop claims are returned
 * for the mod to send through the app, then one idle-reaper pass (SW-39). Never merges and
 * never closes out.
 */
export async function watchPrs(
  opts: { desktop: boolean },
  deps: Deps = defaultDeps(),
  send: (cb: PrCallback) => Promise<void> = deliverHeadless,
  idleLock = path.join(sandboxHome(), "idle-stop.lock"),
): Promise<{ ok: boolean; lines: string[]; desktop: PrCallback[] }> {
  const { workspaces } = await listWorkspaces();
  const { claimed, lines } = await claimCallbacks(
    workspaces.map((w) => w.path),
    opts,
    deps,
  );
  const desktop: PrCallback[] = [];
  for (const cb of claimed) {
    if (cb.hostSession) {
      desktop.push(cb);
      continue;
    }
    try {
      await send(cb);
      lines.push(`${cb.dir}: resumed session ${cb.session}: ${cb.message}`);
    } catch (e) {
      lines.push(`${cb.dir}: could not resume session ${cb.session}: ${(e as Error).message}`);
    }
  }
  // Its own lock: every desktop session's timer runs this pass, and two reapers would race compose.
  fs.mkdirSync(path.dirname(idleLock), { recursive: true });
  if (takeLock(idleLock)) {
    try {
      lines.push(...(await deps.reapIdle()).lines);
    } finally {
      fs.rmSync(idleLock, { force: true });
    }
  } else lines.push("another idle-stop pass is running");
  return { ok: true, lines, desktop };
}

/**
 * `werkmeister pr adopt`: record a fix that landed outside the workspace, so close-out can run.
 * With *pr*, write the PR from `gh pr view` and let `refreshPrStatus` promote it; with
 * *noPr*, the fix is already on base and the file is `closed` with that reason.
 */
export async function adoptPr(
  ws: string,
  opts: { pr?: string; noPr?: string; repo?: string },
  deps: Deps = defaultDeps(),
): Promise<{ ok: boolean; lines: string[] }> {
  const dir = prFileDir(ws);
  if (!dir) throw new WorkspaceError("This workspace has no stage to hold a PR file.");
  let repo = opts.repo;
  if (!repo) {
    const wts = await listRepoWorktrees(ws);
    if (wts.length !== 1)
      throw new WorkspaceError(
        `Name the repo — this workspace has ${wts.map((w) => w.repo).join(", ") || "no code worktree"}.`,
      );
    repo = wts[0].repo;
  }
  let file = path.join(dir, `pr-${repo}.md`);
  const taken = () => {
    if (fs.existsSync(file))
      throw new WorkspaceError(`${file} already exists — remove it first to adopt.`);
  };

  let fm: Record<string, unknown>;
  let title: string;
  if (opts.noPr !== undefined) {
    if (!opts.noPr.trim()) throw new WorkspaceError("--no-pr needs a reason.");
    taken();
    fm = { status: "closed", reason: opts.noPr.trim(), adopted: true };
    title = "No PR: the fix is already on base";
  } else {
    if (!opts.pr) throw new WorkspaceError("Give a PR number or URL, or --no-pr <reason>.");
    const v = await deps.run(
      "gh",
      ["pr", "view", opts.pr, "--json", "url,headRefName,baseRefName,title,state,mergeCommit"],
      path.join(ws, repo),
    );
    if (v.code !== 0) throw new WorkspaceError(`gh pr view ${opts.pr} failed — ${v.stderr.trim()}`);
    const pr = JSON.parse(v.stdout) as {
      url: string;
      headRefName: string;
      baseRefName: string;
      title: string;
      state: string;
      mergeCommit?: { oid?: string } | null;
    };
    if (pr.state !== "MERGED" && pr.state !== "OPEN")
      throw new WorkspaceError(
        `${pr.url} is ${pr.state}, not merged — use --no-pr <reason> if the fix landed another way.`,
      );
    const tracked = readPrFiles(ws).find((f) => f.fm["url"] === pr.url);
    if (tracked)
      throw new WorkspaceError(`${pr.url} is already tracked in ${path.basename(tracked.path)}.`);
    // The worktree's first PR file is taken: adopt as a follow-up named by PR number (SW-103).
    const followUp = fs.existsSync(file);
    if (followUp) file = path.join(dir, `pr-${repo}-${/\/pull\/(\d+)/.exec(pr.url)?.[1]}.md`);
    taken();
    const merged = pr.state === "MERGED";
    fm = {
      ...(followUp ? { worktree: repo } : {}),
      repo: /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1] ?? "",
      branch: pr.headRefName,
      base: pr.baseRefName,
      status: merged ? "merged" : "open",
      url: pr.url,
      ...(merged ? { merge_sha: pr.mergeCommit?.oid ?? "" } : {}),
      adopted: true,
    };
    title = pr.title;
  }
  // Through the YAML library: a hand-written `release: @scope/pkg@1.0` is invalid YAML.
  fs.writeFileSync(
    file,
    `---\n${YAML.stringify(fm)}---\n# ${title}\n\nAdopted with \`werkmeister pr adopt\`: the work landed outside this workspace.\n`,
  );
  const lines = [`${path.basename(file, ".md").replace(/^pr-/, "")}: adopted as ${fm["status"]}`];
  if (fm["status"] !== "closed") lines.push(...(await refreshPrStatus(ws, deps)).lines);
  // No-op when refreshPrStatus already committed it.
  lines.push((await deps.commitRecord(ws, "chore: adopt PR", [path.relative(ws, file)])).message);
  return { ok: true, lines };
}

/**
 * `werkmeister pr new <worktree> --slug <slug>`: a follow-up PR for code written after *worktree*'s
 * PR merged (SW-103). Cuts `<branch>-<slug>` from base, since a squash-merged branch's commits
 * are not on base, and writes `pr-<worktree>-<slug>.md` at `status: draft`.
 */
export async function newPr(
  ws: string,
  worktree: string,
  slug: string,
  deps: Deps = defaultDeps(),
): Promise<{ ok: boolean; lines: string[] }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
    throw new WorkspaceError("--slug: lowercase letters, digits and dashes.");
  const dir = prFileDir(ws);
  if (!dir) throw new WorkspaceError("This workspace has no stage to hold a PR file.");
  const mine = readPrFiles(ws).filter((f) => f.dir === worktree);
  if (!mine.length)
    throw new WorkspaceError(
      `No PR file for ${worktree} yet — the first PR is pr-${worktree}.md (format: ${prRulesPath(ws)}).`,
    );
  const live = mine.filter((f) => !PAST_MERGE.has(statusOf(f)));
  if (live.length)
    throw new WorkspaceError(
      `${worktree} still has ${live.map((f) => `${f.stem} (${statusOf(f)})`).join(", ")} — the worktree holds one branch at a time; finish or close that PR first.${
        live.some((f) => statusOf(f) !== "draft")
          ? " If it has merged, run werkmeister pr status first to record it."
          : ""
      }`,
    );
  const file = path.join(dir, `pr-${worktree}-${slug}.md`);
  if (fs.existsSync(file)) throw new WorkspaceError(`${file} already exists.`);
  const wt = path.join(ws, worktree);
  const dirty = await deps.run("git", ["-C", wt, "status", "--porcelain"]);
  if (dirty.code !== 0 || dirty.stdout.trim())
    throw new WorkspaceError(
      `${worktree} has uncommitted changes — commit or stash them first.${dirty.stderr.trim() ? ` ${dirty.stderr.trim()}` : ""}`,
    );
  const prev = mine.find((f) => f.stem === worktree) ?? mine[0];
  const branch = `${String(prev.fm["branch"] ?? "")}-${slug}`;
  const base = String(prev.fm["base"] ?? "main");
  for (const args of [
    ["fetch", "-q", "origin", base],
    ["switch", "--no-track", "-c", branch, `origin/${base}`],
  ]) {
    const r = await deps.run("git", ["-C", wt, ...args]);
    if (r.code !== 0) throw new WorkspaceError(`git ${args[0]} failed — ${r.stderr.trim()}`);
  }
  const fm = { worktree, repo: prev.fm["repo"], branch, base, status: "draft" };
  fs.writeFileSync(
    file,
    `---\n${YAML.stringify(fm)}---\n# <PR title>\n\n<body: summary, test and exercise results, acceptance table: a result cell of exactly PASS or FAIL, evidence in its own column — see ${path.basename(prRulesPath(ws))}>\n`,
  );
  const rel = path.relative(ws, file);
  return {
    ok: true,
    lines: [
      `${worktree}-${slug}: draft ${rel} on ${branch} (from origin/${base})`,
      (await deps.commitRecord(ws, "chore: start follow-up PR", [rel])).message,
    ],
  };
}

/** The workspace's place in the lifecycle, from files only — cheap enough for the pane's poll. */
export function lifecycleOf(ws: string): {
  state: Lifecycle;
  prs: Array<{
    dir: string;
    stem: string;
    status: string;
    url: string | null;
    release: string | null;
  }>;
} {
  let files: PrFile[] = [];
  try {
    files = readPrFiles(ws);
  } catch {
    /* a malformed PR file reads as still working; the gate reports it */
  }
  const prs = files.map((f) => ({
    dir: f.dir,
    stem: f.stem,
    status: statusOf(f),
    url: f.fm["url"] ? String(f.fm["url"]) : null,
    release: f.fm["release"] ? String(f.fm["release"]) : null,
  }));
  const all = (set: Set<string>) => prs.every((p) => set.has(p.status));
  let state: Lifecycle;
  if (fs.existsSync(path.join(ws, "closeout.md"))) state = "closed-out";
  else if (!prs.length) state = "working";
  else if (all(new Set(["abandoned"]))) state = "abandoned";
  else if (all(SETTLED)) state = "shipped";
  else if (all(PAST_MERGE)) state = "merged";
  else if (prs.some((p) => p.status === "open")) state = "pr-open";
  else if (all(new Set(["approved"]))) state = "ready";
  else state = "working";
  return { state, prs };
}

// ---- remove precondition and close-out -------------------------------------

/** Why removing *ws* would lose unshipped work; empty when it is safe. */
export async function removalBlockers(
  ws: string,
  worktrees: Array<{ repo: string; dir: string }>,
  run: Run = execRun,
): Promise<string[]> {
  if (fs.existsSync(path.join(ws, "closeout.md"))) return [];
  const files = readPrFiles(ws);
  const out: string[] = [];
  for (const { repo, dir } of worktrees) {
    const mine = files.filter((x) => x.dir === repo);
    const open = mine.find((x) => statusOf(x) === "open");
    if (open) {
      out.push(`${repo}: PR is open (${open.fm["url"]})`);
      continue;
    }
    if (mine.length && mine.every((x) => PAST_MERGE.has(statusOf(x)))) continue;
    const f = mine.find((x) => !PAST_MERGE.has(statusOf(x)));
    const base = f?.fm["base"] ? `origin/${f.fm["base"]}` : await originBase(dir, run);
    const n = (await commitsAhead(dir, base, run)) ?? 0;
    if (n > 0) out.push(`${repo}: ${n} commit(s) not on ${base} and no merged PR`);
  }
  return out;
}

async function originBase(dir: string, run: Run): Promise<string> {
  const head = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : "origin/main";
}

/** Commits on *dir*'s HEAD that *base* (default: origin's default branch) lacks; null when git can't tell. */
export async function commitsAhead(
  dir: string,
  base?: string,
  run: Run = execRun,
): Promise<number | null> {
  const ahead = await run("git", [
    "-C",
    dir,
    "rev-list",
    "--count",
    `${base ?? (await originBase(dir, run))}..HEAD`,
  ]);
  return ahead.code === 0 ? Number(ahead.stdout.trim()) : null;
}

export function renderCloseout(prs: PrFile[], issue: string, note?: string): string {
  const cell = (v: unknown) => (v ? String(v).replace(/\|/g, "\\|") : "—");
  return [
    "# Close-out",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Issue: ${issue}`,
    ...(note ? [note] : []),
    "",
    "| repo | PR | status | merge_sha | release | reason |",
    "|---|---|---|---|---|---|",
    ...prs.map(
      (f) =>
        `| ${cell(f.fm["repo"] ?? f.dir)} | ${cell(f.fm["url"])} | ${statusOf(f)} | ${cell(f.fm["merge_sha"])} | ${cell(f.fm["release"])} | ${cell(f.fm["reason"])} |`,
    ),
    "",
  ].join("\n");
}

/** `--abandon`: record *why* on every unsettled PR file and in closeout.md. */
export function abandonWorkspace(ws: string, why: string): void {
  const files = readPrFiles(ws);
  for (const f of files)
    if (!SETTLED.has(statusOf(f))) writePrFields(f, { status: "abandoned", reason: why });
  fs.writeFileSync(
    path.join(ws, "closeout.md"),
    renderCloseout(files, "not closed (abandoned)", `Abandoned: ${why}`),
  );
}

/**
 * Running terminal `claude` sessions (a TTY, so not the desktop app's or VS Code's) whose cwd is in *ws*.
 * Nothing outside a terminal can end one, so close-out names them for the person to `/exit`.
 */
export async function openTerminalSessions(ws: string, run: Run = execRun): Promise<string[]> {
  const ps = await run("ps", ["-axo", "pid=,tty=,comm="]);
  if (ps.code !== 0) return [];
  const ttys = new Map<string, string>();
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m && path.basename(m[3]) === "claude" && m[2] !== "??" && m[2] !== "?")
      ttys.set(m[1], m[2]);
  }
  if (!ttys.size) return [];
  const lsof = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", [...ttys.keys()].join(",")]);
  // lsof exits 1 when some pid has gone; what it printed is still good.
  const out: string[] = [];
  let pid = "";
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && ttys.has(pid)) {
      const cwd = line.slice(1);
      if (cwd === ws || cwd.startsWith(ws + path.sep))
        out.push(`terminal session: pid ${pid} on ${ttys.get(pid)} in ${cwd} — /exit it`);
    }
  }
  return out;
}

/**
 * The one end-of-workspace verb (#160). Shipped: close the issue, write closeout.md, remove, delete
 * the merged branches. With *abandon*: record the reason, leave the issue, remove (which pushes every
 * branch) and keep the branches.
 */
export async function closeOut(
  name: string,
  opts: { abandon?: string; skipPostmortem?: string } = {},
  deps: Deps = defaultDeps(),
): Promise<{ command: string; output: string; path: string; terminals: string[] }> {
  const why = opts.abandon?.trim();
  if (opts.abandon !== undefined && !why) {
    throw new WorkspaceError(
      `Abandon needs a reason: werkmeister close-out ${name} --abandon "<reason>"`,
    );
  }
  const skip = opts.skipPostmortem?.trim();
  if (opts.skipPostmortem !== undefined && !skip) {
    throw new WorkspaceError(
      `Skipping the post-mortem needs a reason: werkmeister close-out ${name} --skip-postmortem "<reason>"`,
    );
  }
  const ws = await resolveWorkspaceDir(name).catch((e: Error) => {
    // A finished close-out removed the folder, so a rerun lands here (SW-90).
    throw /^No such workspace/.test(e.message)
      ? new WorkspaceError(`${e.message} — already closed out, or never created.`)
      : e;
  });
  // Fail fast rather than wait: the pane, MCP server and VS Code call this in long-lived processes,
  // and the run holding the lock reports the outcome itself.
  const lock = path.join(sandboxHome(), `close-out-${path.basename(ws)}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (!takeLock(lock)) {
    throw new WorkspaceError(
      `close-out of '${name}' is already running; that run reports the result. If none is, delete ${lock}.`,
    );
  }
  try {
    return await closeOutLocked(name, ws, why, skip, deps);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

async function closeOutLocked(
  name: string,
  ws: string,
  why: string | undefined,
  skip: string | undefined,
  deps: Deps,
): Promise<{ command: string; output: string; path: string; terminals: string[] }> {
  const command = `werkmeister close-out ${name}${why ? " --abandon" : ""}`;
  const cfg = loadConfigFile(ws, null);
  // SW-108: a run's lessons go with the workspace unless someone asks for them on purpose.
  // A retry (closeout.md written, removal failed) already passed this.
  const postmortem = path.join(ws, "postmortem.md");
  const postmortemRefusal =
    !skip && !fs.existsSync(path.join(ws, "closeout.md")) && !fs.existsSync(postmortem)
      ? `'${name}' has no postmortem.md. Run the post-mortem first: ask Claude to close out (the werkmeister \`postmortem\` skill), ` +
        `or skip it with \`werkmeister close-out ${name}${why ? ' --abandon "<reason>"' : ""} --skip-postmortem "<reason>"\`.`
      : null;
  // Before abandonWorkspace, which rewrites the PR files: a refusal changes nothing.
  if (why && postmortemRefusal) throw new WorkspaceError(postmortemRefusal);
  if (why) abandonWorkspace(ws, why);
  const life = lifecycleOf(ws);
  const spikeDone =
    life.prs.length === 0 &&
    String(cfg["work_type"] ?? "")
      .trim()
      .toLowerCase() === "spike";
  // closed-out: closeout.md was written but removal failed; running again finishes it.
  if (
    !(
      life.state === "shipped" ||
      life.state === "abandoned" ||
      life.state === "closed-out" ||
      spikeDone
    )
  ) {
    const detail = life.prs.map((p) => `${p.stem}: ${p.status}`).join(", ") || "no PR files";
    throw new WorkspaceError(
      `'${name}' is ${life.state} (${detail}). Close-out needs every PR shipped, closed or abandoned — run \`werkmeister pr status\` after the release, ` +
        `or give up with \`werkmeister close-out ${name} --abandon "<reason>"\`.`,
    );
  }
  // After the ship check, so an unshipped workspace hears that first.
  if (postmortemRefusal) throw new WorkspaceError(postmortemRefusal);
  // Not from the state alone: shipped + newly abandoned PR files read `shipped`, and a retry reads
  // `closed-out`; neither may post "Shipped:" or delete branches.
  const abandoned =
    !!why ||
    life.state === "abandoned" ||
    (life.state === "closed-out" && life.prs.some((p) => p.status === "abandoned"));

  const lines: string[] = [];
  const ref = issueIdOf(cfg);
  let issueLine = "none";
  if (ref) {
    const { tracker, statuses } = trackingOf(cfg, ref, deps);
    // moveIssue never throws: a tracker refusal is a warning here, not a stopped close-out.
    if (why) {
      issueLine = await moveIssue(tracker, ref, "abandoned", statuses, {
        comment: `Abandoned: ${why}`,
        alwaysComment: true,
      });
    } else if (abandoned) {
      // A retry: the first run already commented.
      const current = (await tracker.fetchIssue(ref))?.status ?? "";
      issueLine = `${ref} left ${current || "as is"} (abandoned)`;
    } else {
      issueLine =
        (await moveIssue(tracker, ref, "done", statuses, {
          comment: shippedComment(readPrFiles(ws).filter((f) => statusOf(f) === "shipped")),
        })) || `${ref} left as is (no done status configured)`;
    }
    lines.push(`Issue: ${issueLine}`);
  }

  const files = readPrFiles(ws);
  try {
    fs.writeFileSync(
      path.join(ws, "closeout.md"),
      renderCloseout(
        files,
        issueLine,
        [
          why && `Abandoned: ${why}`,
          skip
            ? `Post-mortem skipped: ${skip}`
            : fs.existsSync(postmortem) && "Post-mortem: postmortem.md",
        ]
          .filter(Boolean)
          .join("\n") || undefined,
      ),
    );
  } catch (e) {
    // Removed while the issue moved, by something outside this lock (`werkmeister remove`, rm).
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || fs.existsSync(ws)) throw e;
    lines.push(`'${name}' is already closed out or removed: ${ws} is gone.`);
    return { command, output: lines.join("\n"), path: ws, terminals: [] };
  }
  const branches: Array<{ src: string; branch: string }> = [];
  // An adopted PR's branch was never this workspace's to delete; an abandoned workspace keeps them all.
  for (const f of abandoned
    ? []
    : files.filter(
        (x) => (statusOf(x) === "merged" || statusOf(x) === "shipped") && !x.fm["adopted"],
      )) {
    const src = await deps.sourceOf(path.join(ws, f.dir));
    if (src && f.fm["branch"]) branches.push({ src, branch: String(f.fm["branch"]) });
  }

  // Before removal: the cwd of a session in a deleted folder no longer matches it.
  const terminals = await deps.terminals(ws);
  lines.push((await deps.remove(name, abandoned)).output);

  // After removal: a branch checked out in a worktree can't be deleted.
  for (const { src, branch } of branches) {
    const local = await deps.run("git", ["-C", src, "branch", "-D", branch]);
    lines.push(
      local.code === 0 ? `deleted local ${branch}` : `local ${branch}: ${local.stderr.trim()}`,
    );
    const remote = await deps.run("git", [
      "-C",
      src,
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      branch,
    ]);
    if (remote.code === 0) {
      const del = await deps.run("git", ["-C", src, "push", "origin", "--delete", branch]);
      lines.push(
        del.code === 0 ? `deleted origin/${branch}` : `origin/${branch}: ${del.stderr.trim()}`,
      );
    } else {
      lines.push(`origin/${branch} already gone`);
    }
  }
  lines.push(...terminals);
  return { command, output: lines.filter(Boolean).join("\n"), path: ws, terminals };
}
