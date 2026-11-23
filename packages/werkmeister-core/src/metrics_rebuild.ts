/**
 * `werkmeister metrics rebuild` (SW-780, design SW-772 § Q4): backfill the metrics event log from
 * record branches (`usage.json`, stage commits), GitHub PR times, CI coverage artifacts (SW-405) and the transcripts still on disk.
 * Re-running adds nothing; the shared workspace repo is only read, through a temporary bare clone.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getReposRoot, sandboxHome, workspacesRoot } from "./config.js";
import { coverageRows, type PackageCoverage } from "./coverage.js";
import { loadWorkspaceRepo } from "./global_config.js";
import { findClaudeProjectDir, listSessionFiles } from "./harness/claude/transcript.js";
import { WORKSPACE_ROOT_REPO, workspaceRepoUrl } from "./machine_setup.js";
import {
  branchFiles,
  firstFill,
  type MetricsEvent,
  recordEvent,
  usageCachePath,
} from "./metrics.js";
import { warn } from "./reporter.js";
import { runCapture } from "./tool_bins.js";

export type TimedEvent = { e: MetricsEvent; at: string };
export interface RebuildResult {
  added: Record<string, number>;
  total: number;
  /** Record branches whose `usage.json` was cached, with its author, for the `metrics` report. */
  usages: number;
  /** The temporary clone, removed before this returns. */
  clone: string;
}

const ASK_KINDS: Record<string, "question" | "plan"> = {
  AskUserQuestion: "question",
  ExitPlanMode: "plan",
};

/** ask/answer pairs in one transcript; the answer is the tool_result of the ask's tool_use. */
export function transcriptAsks(text: string, workspace: string, session: string): TimedEvent[] {
  const out: TimedEvent[] = [];
  const open = new Map<string, string>();
  for (const line of text.split("\n")) {
    let m: { timestamp?: string; message?: { content?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const at = m?.timestamp;
    const content = m?.message?.content;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || !Array.isArray(content)) continue;
    for (const c of content) {
      const kind = c?.type === "tool_use" ? ASK_KINDS[c.name] : undefined;
      if (kind && typeof c.id === "string") {
        open.set(c.id, at);
        out.push({ e: { event: "ask", workspace, session, kind }, at });
      }
      const asked = c?.type === "tool_result" ? open.get(c.tool_use_id) : undefined;
      if (asked) {
        open.delete(c.tool_use_id);
        const waited_s = Math.max(0, Math.round((Date.parse(at) - Date.parse(asked)) / 1000));
        out.push({ e: { event: "answer", workspace, session, waited_s }, at });
      }
    }
  }
  return out;
}

/** Live `ask`/`answer` lines carry hook time, not transcript time, so a session already logged is skipped whole. */
const keyOf = (e: Record<string, unknown>): string | null =>
  e["event"] === "stage.done"
    ? `stage.done|${e["workspace"]}|${e["stage"]}|${e["commit"]}` // a reused workspace name is a new run
    : e["event"] === "pr.open" || e["event"] === "pr.merged"
      ? `${e["event"]}|${e["pr"]}`
      : null;

function loggedKeys(): {
  keys: Set<string>;
  sessions: Set<string>;
  lines: Set<string>;
  runs: Set<string>;
} {
  const keys = new Set<string>();
  const sessions = new Set<string>();
  const lines = new Set<string>();
  // CI runs whose coverage is logged: each run's artifact is read once (SW-405).
  const runs = new Set<string>();
  const dir = path.join(sandboxHome(), "metrics");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^events-.*\.jsonl$/.test(f));
  } catch {}
  for (const f of files)
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      lines.add(line);
      const k = keyOf(e);
      if (k) keys.add(k);
      if (e["event"] === "ask" || e["event"] === "answer") sessions.add(String(e["session"]));
      if (e["event"] === "coverage" && e["run"]) runs.add(String(e["run"]));
    }
  return { keys, sessions, lines, runs };
}

function git(dir: string, ...args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout : null;
}

function originUrl(): string {
  const checkout = path.join(getReposRoot(), WORKSPACE_ROOT_REPO);
  const url = fs.existsSync(checkout) ? git(checkout, "remote", "get-url", "origin")?.trim() : "";
  if (url) return url;
  const slug = loadWorkspaceRepo();
  if (slug) return workspaceRepoUrl(slug);
  throw new Error("no workspace repo: run `werkmeister machine setup`");
}

async function prEvents(
  url: string,
  workspace: string,
  ticket: string | undefined,
): Promise<TimedEvent[]> {
  let view: { createdAt?: string; mergedAt?: string | null };
  try {
    const r = await runCapture("gh", ["pr", "view", url, "--json", "createdAt,mergedAt"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exit ${r.code}`);
    view = JSON.parse(r.stdout);
  } catch (err) {
    warn(`metrics rebuild: ${url}: ${(err as Error).message}`);
    return [];
  }
  const base = { workspace, ...(ticket && { ticket }), pr: url };
  const out: TimedEvent[] = [];
  if (view.createdAt) out.push({ e: { event: "pr.open", ...base }, at: view.createdAt });
  if (view.mergedAt) out.push({ e: { event: "pr.merged", ...base }, at: view.mergedAt });
  return out;
}

async function branchEvents(
  repo: string,
  branch: string,
  seenSessions: Set<string>,
): Promise<TimedEvent[]> {
  let workspace = branch.slice(branch.indexOf("/") + 1);
  let ticket: string | undefined;
  try {
    const usage = JSON.parse(git(repo, "show", `${branch}:usage.json`) ?? "");
    if (typeof usage.workspace === "string") workspace = usage.workspace;
    if (typeof usage.ticket === "string") ticket = usage.ticket;
  } catch {}

  const out: TimedEvent[] = [];
  const paths = (git(repo, "ls-tree", "-r", "--name-only", branch) ?? "").split("\n");
  const stages = new Set(
    paths.flatMap((p) => /^stages\/(\d+_[a-z_]+)\/output\/(?!\.gitkeep$)[^/]/.exec(p)?.[1] ?? []),
  );
  for (const stage of [...stages].sort()) {
    const fill = firstFill(repo, stage, branch);
    if (fill)
      out.push({ e: { event: "stage.done", workspace, stage, commit: fill.commit }, at: fill.at });
  }
  for (const p of paths.filter((p) =>
    /^(stages\/[^/]+\/output|\.werkmeister\/notes)\/pr-[^/]+\.md$/.test(p),
  )) {
    const url = /^url:\s*["']?([^\s"']+)/m.exec(git(repo, "show", `${branch}:${p}`) ?? "")?.[1];
    if (url) out.push(...(await prEvents(url, workspace, ticket)));
  }

  const projects = await findClaudeProjectDir(path.join(workspacesRoot(), workspace));
  for (const { file } of projects ? await listSessionFiles(projects) : []) {
    const session = path.basename(file, ".jsonl");
    if (seenSessions.has(session)) continue;
    seenSessions.add(session); // two branches with one workspace name share its transcripts
    out.push(...transcriptAsks(fs.readFileSync(file, "utf8"), workspace, session));
  }
  return out;
}

/**
 * `coverage` rows from each code repo's CI `coverage-summary` artifacts (SW-405), one per package per
 * run, skipping runs already logged. gh failing warns and imports nothing from that repo.
 */
async function ciCoverage(repos: Set<string>, runs: Set<string>): Promise<TimedEvent[]> {
  const out: TimedEvent[] = [];
  for (const slug of repos) {
    let list: { artifacts?: Array<{ expired?: boolean; workflow_run?: { id?: number } }> };
    try {
      // shortcut: the newest 100 only; page when a repo makes more than that between rebuilds.
      const r = await runCapture("gh", [
        "api",
        `repos/${slug}/actions/artifacts?name=coverage-summary&per_page=100`,
      ]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exit ${r.code}`);
      list = JSON.parse(r.stdout);
    } catch (err) {
      warn(`metrics rebuild: CI coverage of ${slug}: ${(err as Error).message}`);
      continue;
    }
    for (const a of list.artifacts ?? []) {
      const run = String(a.workflow_run?.id ?? "");
      if (!run || a.expired || runs.has(run)) continue;
      runs.add(run);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-coverage-"));
      try {
        const args = ["run", "download", run, "-R", slug, "-n", "coverage-summary", "-D", dir];
        const r = await runCapture("gh", args);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exit ${r.code}`);
        const s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
        // The artifact's own fields: a bad time or commit would break the log's month file or every row.
        if (typeof s.generatedAt !== "string" || Number.isNaN(Date.parse(s.generatedAt)))
          throw new Error("summary.json has no valid generatedAt");
        if (typeof s.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(s.commit))
          throw new Error("summary.json has no valid commit");
        s.generatedAt = new Date(s.generatedAt).toISOString();
        // A merge-queue run tests what main becomes, so it counts as main.
        const source = s.ci?.event === "pull_request" ? "ci-pr" : "ci-main";
        const pkgs = Object.entries(s.packages ?? {}).map(([name, p]) => ({
          ...(p as Omit<PackageCoverage, "name">),
          name,
        }));
        for (const e of coverageRows(pkgs, { source, commit: String(s.commit), run }))
          out.push({ e, at: s.generatedAt });
      } catch (err) {
        warn(`metrics rebuild: CI coverage of ${slug} run ${run}: ${(err as Error).message}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return out;
}

/** Backfills the event log; throws when the workspace repo can't be found or cloned. */
export async function rebuildMetrics(): Promise<RebuildResult> {
  const { keys, sessions, lines, runs } = loggedKeys();
  const usages: string[] = [];
  const url = originUrl();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-records-"));
  const repo = path.join(tmp, "repo");
  const added: Record<string, number> = {
    "stage.done": 0,
    "pr.open": 0,
    "pr.merged": 0,
    ask: 0,
    answer: 0,
    coverage: 0,
  };
  // The code repos, from the PR links on record branches: where CI coverage is (SW-405).
  const repos = new Set<string>();
  try {
    // Never fetch into the shared checkout (SW-780): a bare clone of its origin, removed below.
    const clone = spawnSync("git", ["clone", "--bare", "--quiet", url, repo], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (clone.status !== 0)
      throw new Error(`could not clone ${url}: ${clone.stderr.trim() || clone.error?.message}`);
    const head = git(repo, "symbolic-ref", "--short", "HEAD")?.trim();
    const branches = (git(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)") ?? "")
      .split("\n")
      .filter((b) => b && b !== head);
    const slices = branchFiles(repo, branches, "metrics.jsonl");
    const usageFiles = branchFiles(repo, branches, "usage.json");
    const log = ({ e, at }: TimedEvent) => {
      const k = keyOf(e);
      if (k && keys.has(k)) return;
      if (k) keys.add(k);
      if (recordEvent(e, at)) added[e.event] = (added[e.event] ?? 0) + 1;
    };
    for (const branch of branches) {
      // The slice first (SW-1104): its live times beat the ones rebuilt below, which keyOf then skips.
      for (const line of (slices.get(branch) ?? "").split("\n")) {
        if (!line || lines.has(line)) continue; // close-out copies lines verbatim, so the owner's are here
        lines.add(line);
        const t = sliceEvent(line);
        if (!t) continue;
        if (t.e.event === "ask" || t.e.event === "answer") sessions.add(t.e.session);
        log(t);
      }
      for (const t of await branchEvents(repo, branch, sessions)) {
        const slug =
          "pr" in t.e ? /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(t.e.pr)?.[1] : undefined;
        if (slug) repos.add(slug);
        log(t);
      }
      const usage = parseUsage(usageFiles.get(branch));
      if (usage) {
        const by = git(repo, "log", "-1", "--format=%ae", branch)?.trim() || undefined;
        usages.push(JSON.stringify({ ...usage, by }));
      }
    }
    fs.mkdirSync(path.dirname(usageCachePath()), { recursive: true });
    fs.writeFileSync(usageCachePath(), usages.map((u) => `${u}\n`).join(""));
    for (const t of await ciCoverage(repos, runs)) log(t);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return {
    added,
    total: Object.values(added).reduce((a, b) => a + b, 0),
    usages: usages.length,
    clone: tmp,
  };
}

/** A teammate's slice line as an event; null unless it names its time, event and workspace. */
function sliceEvent(line: string): TimedEvent | null {
  try {
    const { v: _v, at, ...e } = JSON.parse(line);
    return typeof at === "string" && typeof e.event === "string" && typeof e.workspace === "string"
      ? { e: e as MetricsEvent, at }
      : null;
  } catch {
    return null;
  }
}

function parseUsage(text: string | undefined): Record<string, unknown> | null {
  try {
    const u = JSON.parse(text ?? "");
    return typeof u?.workspace === "string" && typeof u?.closedAt === "string" ? u : null;
  } catch {
    return null;
  }
}
