/**
 * Workspace PR lifecycle (docs/workspace-lifecycle.md): per-repo PR files, the
 * pre-PR gate, `sandbox pr open|status`, the lifecycle state the pane shows,
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
import {
  type ArchetypeRegistry,
  loadArchetypes,
  loadReposConfig,
  loadServices,
  type RepoEntry,
  type ReposConfig,
  type ServicesConfig,
  sandboxHome,
} from "./config.js";
import { load as loadGlobalConfig } from "./global_config.js";
import { updateNoteStatus } from "./graduate.js";
import { issueIdOf, issueTracker, loadIssueTracker } from "./issue_tracker.js";
import type { IssueTrackerStrategy } from "./issue_trackers/types.js";
import { openDecisions } from "./notes.js";
import {
  commitAndPush,
  listRepoWorktrees,
  listWorkspaces,
  removeWorkspace,
  resolveSessionSource,
  resolveWorkspaceDir,
  sendToClaudeSession,
  WorkspaceError,
  worktreeSources,
} from "./sandbox.js";
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
  tracker: IssueTrackerStrategy;
  doneStatus: string;
  /** Commit and push *paths* (relative to the workspace) on the record branch — nothing else that is dirty. */
  commitRecord: (
    ws: string,
    message: string,
    paths: string[],
  ) => Promise<{ ok: boolean; message: string }>;
  remove: (name: string) => Promise<{ output: string }>;
  /** Terminal sessions still open in the workspace, one line each. */
  terminals: (ws: string) => Promise<string[]>;
  sourceOf: (dir: string) => Promise<string | null>;
  /** The PR file's callback fields for the session running `pr open` (#236). */
  session: (ws: string) => Promise<Record<string, string>>;
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
  const overrides = loadGlobalConfig()["overrides"] ?? {};
  return {
    run: execRun,
    httpStatus,
    services: loadServices(),
    archetypes: loadArchetypes(),
    repos: loadReposConfig(),
    tracker: issueTracker(),
    doneStatus: String(
      overrides["issue_done_status"] ?? (loadIssueTracker() === "github" ? "closed" : "Done"),
    ),
    commitRecord: commitAndPush,
    remove: (name) => removeWorkspace(name, { closedOut: true }),
    terminals: (ws) => openTerminalSessions(ws),
    sourceOf: async (dir) => (await worktreeSources([dir]))[0] ?? null,
    session: (ws) => callbackFields(ws, process.env),
  };
}

// ---- PR files --------------------------------------------------------------

/**
 * Where PR files live: the propose stage's output (ICM), else `.sandbox/notes`
 * (JIT). `_ship` is the stage name before decision 11; null for a staged
 * workspace with neither (spike).
 */
export function prFileDir(ws: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(ws, "stages")).sort();
  } catch {
    return path.join(ws, ".sandbox", "notes");
  }
  const dir = names.find((n) => /^\d+_propose$/.test(n)) ?? names.find((n) => /^\d+_ship$/.test(n));
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
  return {
    path: p,
    dir: path.basename(p).replace(/^pr-/, "").replace(/\.md$/, ""),
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

function passTable(text: string): string | null {
  if (FAIL_CELL.test(text)) return "has a FAIL row";
  if (!PASS_CELL.test(text)) return "has no PASS row";
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
    const p = path.join(ws, ".sandbox", "notes", "exercise.md");
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

export async function runGate(
  ws: string,
  file: PrFile,
  deps: Deps = defaultDeps(),
): Promise<GateResult> {
  const checks: GateCheck[] = [stagesCheck(ws)];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const table = passTable(file.body);
  add("acceptance", table === null, table ? `PR file ${table}` : "all PASS");

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

  const cfg = loadConfigFile(ws, null);
  const feature = String(cfg["feature"] ?? readEnv(ws, "FEATURE")).trim();
  const local = new Set(
    String(cfg["services"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const repo = deps.repos[file.dir] ?? {};
  const ps = await deps.run("docker", ["ps", "--format", "{{.Names}}"]);
  const running = new Set(
    ps.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const containerFor = (svc: string): string | null => {
    const own = `${feature}-${svc}`;
    if (running.has(own)) return own;
    // Every container of a repo mounts the same worktree at /app with its node_modules.
    const sibling = ((repo["services"] ?? []) as string[])
      .map((s) => `${feature}-${s}`)
      .find((c) => running.has(c));
    return sibling ?? null;
  };

  const base = String(file.fm["base"] ?? "main");
  const diff = await deps.run("git", ["-C", dir, "diff", "--name-only", `origin/${base}...HEAD`]);
  if (diff.code !== 0) {
    add("tests", false, `cannot diff against origin/${base}: ${diff.stderr.trim()}`);
  }
  const touched = diff.code === 0 ? mapTouched(diff.stdout.split("\n").filter(Boolean), repo) : [];
  const skips = (file.fm["skip_tests"] ?? {}) as Record<string, unknown>;
  for (const svc of touched) {
    const cmd = serviceTestCommand(svc, deps.services[svc], deps.archetypes);
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
        why ? `skipped: ${why}` : "no running container for this repo — run `sandbox up`",
      );
      continue;
    }
    const res = await deps.run("docker", ["exec", container, "sh", "-c", cmd]);
    add(
      `test ${svc}`,
      res.code === 0,
      `${cmd} → exit ${res.code}${res.code ? `\n${(res.stdout + res.stderr).trimEnd().split("\n").slice(-15).join("\n")}` : ""}`,
    );
  }

  const evidence = exerciseFile(ws);
  const evidenceProblem = evidence ? passTable(fs.readFileSync(evidence, "utf8")) : "is missing";
  add(
    "exercise",
    evidenceProblem === null,
    evidence
      ? `${path.relative(ws, evidence)} ${evidenceProblem ?? "all PASS"}`
      : "no exercise.md — record the exercise checks first",
  );
  const slot = Number(readEnv(ws, "SANDBOX_SLOT"));
  for (const svc of touched.filter((s) => local.has(s))) {
    const def = deps.services[svc] ?? {};
    if (!running.has(`${feature}-${svc}`)) {
      add(`baseline ${svc}`, false, "container not running — run `sandbox up`");
      continue;
    }
    if (def["type"] !== "api" && def["type"] !== "web") {
      add(`baseline ${svc}`, true, "container running");
      continue;
    }
    const url = `http://localhost:${getServicePort(slot, def["port_offset"] ?? 0)}${def["health_endpoint"] ?? "/"}`;
    const code = await deps.httpStatus(url);
    add(`baseline ${svc}`, code > 0 && code < 400, `GET ${url} → ${code || "unreachable"}`);
  }

  if (repo["ship"] === "tag" && repo["release_check"]) {
    const why = reason(file.fm["skip_release"]);
    const container =
      touched.map(containerFor).find(Boolean) ??
      containerFor(((repo["services"] ?? []) as string[])[0] ?? "");
    if (why) add("release", true, `skipped: ${why}`);
    else if (!container)
      add("release", false, "no running container for this repo — run `sandbox up`");
    else {
      const res = await deps.run("docker", ["exec", container, "sh", "-c", repo["release_check"]]);
      add(
        "release",
        res.code === 0,
        `${repo["release_check"]} → exit ${res.code}${res.code ? `\n${(res.stdout + res.stderr).trimEnd().split("\n").slice(-5).join("\n")}` : ""}`,
      );
    }
  }

  add("approved", statusOf(file) === "approved", `status: ${statusOf(file)}`);
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
  const files = selectFiles(ws, only, () => true);
  const lines: string[] = [];
  let ok = true;
  for (const f of files) {
    const g = await runGate(ws, f, deps);
    ok &&= g.ok;
    lines.push(...formatGate(f.dir, g));
  }
  return { ok, lines };
}

function selectFiles(ws: string, only: string | undefined, keep: (f: PrFile) => boolean): PrFile[] {
  const all = readPrFiles(ws);
  const files = only ? all.filter((f) => f.dir === only) : all.filter(keep);
  if (!files.length) {
    const where = prFileDir(ws) ?? "this workspace (no propose stage)";
    throw new WorkspaceError(
      only
        ? `No PR file pr-${only}.md in ${where}.`
        : `No matching PR file in ${where}. See pr-rules.md.`,
    );
  }
  return files;
}

export async function openPrs(
  ws: string,
  only?: string,
  deps: Deps = defaultDeps(),
): Promise<{ ok: boolean; lines: string[] }> {
  const files = selectFiles(ws, only, (f) => statusOf(f) === "approved");
  const lines: string[] = [];
  let ok = true;
  const opened: string[] = [];
  for (const f of files) {
    const g = await runGate(ws, f, deps);
    if (!g.ok) {
      ok = false;
      lines.push(...formatGate(f.dir, g));
      continue;
    }
    const dir = path.join(ws, f.dir);
    const branch = String(f.fm["branch"] ?? "");
    const push = await deps.run("git", ["-C", dir, "push", "-u", "origin", branch]);
    if (push.code !== 0) {
      ok = false;
      lines.push(`${f.dir}: push failed — ${push.stderr.trim()}`);
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
      const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-pr-")), "body.md");
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
          `${f.dir}: gh pr create failed — ${created.stderr.trim() || created.stdout.trim()}`,
        );
        continue;
      }
    }
    writePrFields(f, { status: "open", url, ...(await deps.session(ws)) });
    opened.push(path.relative(ws, f.path));
    lines.push(`${f.dir}: open ${url}`);
    const ref = issueIdOf(loadConfigFile(ws, null));
    if (ref) {
      try {
        await deps.tracker.updateIssue(ref, { status: "In Development" });
      } catch (e) {
        lines.push(`  (issue ${ref} not moved to In Development: ${(e as Error).message})`);
      }
    }
  }
  if (opened.length)
    lines.push((await deps.commitRecord(ws, "chore: record opened PR(s)", opened)).message);
  return { ok, lines };
}

export async function refreshPrStatus(
  ws: string,
  deps: Deps = defaultDeps(),
): Promise<{ lines: string[]; changed: boolean }> {
  const lines: string[] = [];
  const changed: string[] = [];
  for (const f of readPrFiles(ws)) {
    const before = statusOf(f);
    if (before === "open" && f.fm["url"]) {
      const v = await deps.run("gh", [
        "pr",
        "view",
        String(f.fm["url"]),
        "--json",
        "state,mergeCommit",
      ]);
      if (v.code !== 0) {
        lines.push(`${f.dir}: gh pr view failed — ${v.stderr.trim()}`);
        continue;
      }
      const view = JSON.parse(v.stdout) as {
        state?: string;
        mergeCommit?: { oid?: string } | null;
      };
      if (view.state === "MERGED")
        writePrFields(f, { status: "merged", merge_sha: view.mergeCommit?.oid ?? "" });
      else if (view.state === "CLOSED")
        writePrFields(f, {
          status: "closed",
          reason: reason(f.fm["reason"]) || "closed on GitHub",
        });
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
    if (after !== before) changed.push(path.relative(ws, f.path));
    lines.push(
      `${f.dir}: ${after}${f.fm["release"] ? ` (${f.fm["release"]})` : ""}${f.fm["url"] ? ` ${f.fm["url"]}` : ""}`,
    );
  }
  if (changed.length)
    lines.push((await deps.commitRecord(ws, "chore: record PR status", changed)).message);
  return { lines, changed: changed.length > 0 };
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
  /** The desktop app's `local_…` id: delivered by the sandbox-tools mod, never headless. */
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
  return host ? { session, host_session: host } : { session };
}

export function callbackMessage(status: string, url: string, release?: string): string | null {
  if (status === "merged")
    return `PR ${url} merged. Run \`sandbox pr status\`, then follow the workspace router.`;
  if (status === "shipped")
    return `PR ${url} shipped${release ? ` in ${release}` : ""}. Ask the person whether to run \`sandbox close-out\`.`;
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
            hostSession: reason(f.fm["host_session"]) || null,
            message,
          });
        writePrFields(
          f,
          SETTLED.has(status)
            ? { session: undefined, host_session: undefined, notified: undefined }
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

/** Resume a terminal session headlessly with its message. */
export async function deliverHeadless(cb: PrCallback): Promise<void> {
  const name = path.basename(cb.ws);
  // sendToClaudeSession falls back to the newest session for an unknown id; a callback reaches its own or none.
  if ((await resolveSessionSource(name, cb.session)).sessionId !== cb.session)
    throw new WorkspaceError(`session ${cb.session} is gone`);
  await sendToClaudeSession(name, cb.message, cb.session);
}

/**
 * `sandbox pr watch` (desktop: false) and the sandbox-tools mod's timer (desktop: true): one
 * pass over every workspace. Headless claims are delivered here; desktop claims are returned
 * for the mod to send through the app. Never merges and never closes out.
 */
export async function watchPrs(
  opts: { desktop: boolean },
  deps: Deps = defaultDeps(),
  send: (cb: PrCallback) => Promise<void> = deliverHeadless,
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
  return { ok: true, lines, desktop };
}

/**
 * `sandbox pr adopt`: record a fix that landed outside the workspace, so close-out can run.
 * With *pr*, write the PR from `gh pr view` and let `refreshPrStatus` promote it; with
 * *noPr*, the fix is already on base and the file is `closed` with that reason.
 */
export async function adoptPr(
  ws: string,
  opts: { pr?: string; noPr?: string; repo?: string },
  deps: Deps = defaultDeps(),
): Promise<{ ok: boolean; lines: string[] }> {
  const dir = prFileDir(ws);
  if (!dir) throw new WorkspaceError("This workspace has no propose stage to hold a PR file.");
  let repo = opts.repo;
  if (!repo) {
    const wts = await listRepoWorktrees(ws);
    if (wts.length !== 1)
      throw new WorkspaceError(
        `Name the repo — this workspace has ${wts.map((w) => w.repo).join(", ") || "no code worktree"}.`,
      );
    repo = wts[0].repo;
  }
  const file = path.join(dir, `pr-${repo}.md`);
  if (fs.existsSync(file))
    throw new WorkspaceError(`${file} already exists — remove it first to adopt.`);

  let fm: Record<string, unknown>;
  let title: string;
  if (opts.noPr !== undefined) {
    if (!opts.noPr.trim()) throw new WorkspaceError("--no-pr needs a reason.");
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
    const merged = pr.state === "MERGED";
    fm = {
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
    `---\n${YAML.stringify(fm)}---\n# ${title}\n\nAdopted with \`sandbox pr adopt\`: the work landed outside this workspace.\n`,
  );
  const lines = [`${repo}: adopted as ${fm["status"]}`];
  if (fm["status"] !== "closed") lines.push(...(await refreshPrStatus(ws, deps)).lines);
  // No-op when refreshPrStatus already committed it.
  lines.push((await deps.commitRecord(ws, "chore: adopt PR", [path.relative(ws, file)])).message);
  return { ok: true, lines };
}

/** The workspace's place in the lifecycle, from files only — cheap enough for the pane's poll. */
export function lifecycleOf(ws: string): {
  state: Lifecycle;
  prs: Array<{ dir: string; status: string; url: string | null }>;
} {
  let files: PrFile[] = [];
  try {
    files = readPrFiles(ws);
  } catch {
    /* a malformed PR file reads as still working; the gate reports it */
  }
  const prs = files.map((f) => ({
    dir: f.dir,
    status: statusOf(f),
    url: f.fm["url"] ? String(f.fm["url"]) : null,
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
    const f = files.find((x) => x.dir === repo);
    const status = f ? statusOf(f) : "none";
    if (f && status === "open") {
      out.push(`${repo}: PR is open (${f.fm["url"]})`);
      continue;
    }
    if (PAST_MERGE.has(status)) continue;
    let base = f?.fm["base"] ? `origin/${f.fm["base"]}` : "";
    if (!base) {
      const head = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
      base = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : "origin/main";
    }
    const ahead = await run("git", ["-C", dir, "rev-list", "--count", `${base}..HEAD`]);
    const n = ahead.code === 0 ? Number(ahead.stdout.trim()) : 0;
    if (n > 0) out.push(`${repo}: ${n} commit(s) not on ${base} and no merged PR`);
  }
  return out;
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
  opts: { abandon?: string } = {},
  deps: Deps = defaultDeps(),
): Promise<{ command: string; output: string; path: string; terminals: string[] }> {
  const why = opts.abandon?.trim();
  if (opts.abandon !== undefined && !why) {
    throw new WorkspaceError(
      `Abandon needs a reason: sandbox close-out ${name} --abandon "<reason>"`,
    );
  }
  const ws = await resolveWorkspaceDir(name);
  const cfg = loadConfigFile(ws, null);
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
    const detail = life.prs.map((p) => `${p.dir}: ${p.status}`).join(", ") || "no PR files";
    throw new WorkspaceError(
      `'${name}' is ${life.state} (${detail}). Close-out needs every PR shipped, closed or abandoned — run \`sandbox pr status\` after the release, ` +
        `or give up with \`sandbox close-out ${name} --abandon "<reason>"\`.`,
    );
  }
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
    const done = deps.doneStatus.toLowerCase();
    const current = (await deps.tracker.fetchIssue(ref))?.status ?? "";
    if (abandoned) {
      issueLine = `${ref} left ${current || "as is"} (abandoned)`;
    } else if ([done, "closed", "done"].includes(current.toLowerCase())) {
      issueLine = `${ref} already ${current}`;
    } else {
      const files = readPrFiles(ws);
      const shipped = files
        .filter((f) => statusOf(f) === "shipped")
        .map((f) => `${f.fm["release"] ?? "merge"} — ${f.fm["url"]}`);
      await deps.tracker.updateIssue(ref, {
        status: deps.doneStatus,
        comment: `Shipped: ${shipped.join("; ") || "no PRs"}`,
      });
      issueLine = `${ref} → ${deps.doneStatus}`;
    }
    lines.push(`Issue: ${issueLine}`);
  }

  const files = readPrFiles(ws);
  fs.writeFileSync(
    path.join(ws, "closeout.md"),
    renderCloseout(files, issueLine, why ? `Abandoned: ${why}` : undefined),
  );
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
  lines.push((await deps.remove(name)).output);

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
  const command = `sandbox close-out ${name}${why ? " --abandon" : ""}`;
  return { command, output: lines.filter(Boolean).join("\n"), path: ws, terminals };
}
