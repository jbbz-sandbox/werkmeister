/**
 * `werkmeister metrics rebuild` (SW-780, design SW-772 § Q4): backfill the metrics event log from
 * record branches (`usage.json`, stage commits), GitHub PR times and the transcripts still on disk.
 * Re-running adds nothing; the shared workspace repo is only read, through a temporary bare clone.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getReposRoot, sandboxHome, workspacesRoot } from "./config.js";
import { loadWorkspaceRepo } from "./global_config.js";
import { findClaudeProjectDir, listSessionFiles } from "./harness/claude/transcript.js";
import { WORKSPACE_ROOT_REPO, workspaceRepoUrl } from "./machine_setup.js";
import { firstFill, type MetricsEvent, recordEvent } from "./metrics.js";
import { warn } from "./reporter.js";
import { runCapture } from "./tool_bins.js";

export type TimedEvent = { e: MetricsEvent; at: string };
export interface RebuildResult {
  added: Record<string, number>;
  total: number;
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

function loggedKeys(): { keys: Set<string>; sessions: Set<string> } {
  const keys = new Set<string>();
  const sessions = new Set<string>();
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
      const k = keyOf(e);
      if (k) keys.add(k);
      if (e["event"] === "ask" || e["event"] === "answer") sessions.add(String(e["session"]));
    }
  return { keys, sessions };
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

/** Backfills the event log; throws when the workspace repo can't be found or cloned. */
export async function rebuildMetrics(): Promise<RebuildResult> {
  const { keys, sessions } = loggedKeys();
  const url = originUrl();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-records-"));
  const repo = path.join(tmp, "repo");
  const added: Record<string, number> = {
    "stage.done": 0,
    "pr.open": 0,
    "pr.merged": 0,
    ask: 0,
    answer: 0,
  };
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
    for (const branch of branches)
      for (const { e, at } of await branchEvents(repo, branch, sessions)) {
        const k = keyOf(e);
        if (k && keys.has(k)) continue;
        if (k) keys.add(k);
        if (recordEvent(e, at)) added[e.event] = (added[e.event] ?? 0) + 1;
      }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { added, total: Object.values(added).reduce((a, b) => a + b, 0), clone: tmp };
}
