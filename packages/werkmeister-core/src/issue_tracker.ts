/**
 * The issue-tracker registry: which tracker this machine files work and bugs
 * against — `overrides.issue_tracker` in ~/.werkmeister/config.yaml, set by
 * `werkmeister machine setup` — and the one door every issue read and write goes through.
 * Callers ask `issueTracker()` and never name a tracker.
 *
 *   jira   (default) — refs are issue keys (`PROJ-12`); bugs are filed in
 *                      that key's Jira project.
 *   github           — issues are per repo (`owner/repo#12`), so the tracker
 *                      spans every repo in the services registry (`repos:`),
 *                      owned by `overrides.github_org`.
 *
 * A workspace's issue is `issue_id` in workspace.yml and `ISSUE_ID` in its
 * .env. Workspaces made before the rename hold `jira_id` / `github_issue` and
 * `JIRA_ID` / `GITHUB_ISSUE`: those are read, never written.
 *
 * Lives in `overrides:` so `werkmeister machine config`, which rebuilds the YAML and keeps
 * overrides verbatim, cannot drop it.
 *
 * Projects (SW-104, projects.ts) narrow this per workspace: a workspace's
 * `project:` picks its tracker and scope, and text with no project is matched
 * to the project whose scope holds its ref. Without either, the machine's tracker.
 */

import { load } from "./global_config.js";
import { github, githubTracker } from "./issue_trackers/github.js";
import { jira, jiraTracker } from "./issue_trackers/jira.js";
import {
  type Issue,
  type IssueTrackerStrategy,
  TRACKER_IDS,
  type TrackerId,
} from "./issue_trackers/types.js";
import { loadProjects, type Project } from "./projects.js";
import { warn } from "./reporter.js";

export {
  GITHUB_ISSUE_PATTERN,
  ghBin,
  githubIssueRepos,
  normalizeGithubIssue,
} from "./issue_trackers/github.js";
export { jiraSitePhrase, jiraSiteRef } from "./issue_trackers/jira.js";
export type {
  Issue,
  IssueComment,
  IssueKind,
  IssueTrackerStrategy,
  IssueUpdate,
  NewIssue,
  TrackerAuth,
  TrackerId,
} from "./issue_trackers/types.js";
export { TRACKER_IDS } from "./issue_trackers/types.js";
export type { Board, Project } from "./projects.js";

const REGISTRY: Record<TrackerId, IssueTrackerStrategy> = { jira, github };

export function trackerById(id: TrackerId): IssueTrackerStrategy {
  return REGISTRY[id];
}

/** The configured tracker's id; anything unrecognised reads as jira. */
export function loadIssueTracker(cfg?: Record<string, any>): TrackerId {
  const id = (cfg ?? load())["overrides"]?.["issue_tracker"];
  return (TRACKER_IDS as readonly string[]).includes(id) ? (id as TrackerId) : "jira";
}

const FACTORIES = { jira: jiraTracker, github: githubTracker } as const;

/** A project's tracker, bound to its scope. */
export function projectTracker(project: Project): IssueTrackerStrategy {
  return FACTORIES[project.tracker](project.scope);
}

/** Where a lookup happens: a workspace's `project:` and/or text holding an issue ref. */
export interface TrackerAt {
  project?: string;
  text?: string;
}

const missingWarned = new Set<string>();

/**
 * The project a lookup lands in: `project` by name; else the first project (by
 * name) whose tracker finds a ref in `text` that its scope holds; else null.
 */
export function projectFor(at: TrackerAt = {}): Project | null {
  const projects = loadProjects();
  if (!projects.length) return null;
  const name = at.project?.trim();
  if (name) {
    const named = projects.find((p) => p.name === name);
    if (named) return named;
    if (!missingWarned.has(name)) {
      missingWarned.add(name);
      warn(`project "${name}" is not in projects: of the config — using the machine's tracker`);
    }
    return null;
  }
  if (!at.text) return null;
  for (const p of projects) {
    const tracker = projectTracker(p);
    const ref = tracker.parseRef(at.text);
    if (ref && tracker.holds(ref)) return p;
  }
  return null;
}

/** The one project marked `default: true`; null when none, or more than one. */
export function defaultProject(): Project | null {
  const marked = loadProjects().filter((p) => p.default);
  return marked.length === 1 ? marked[0] : null;
}

/** The tracker for `at` (see projectFor), else the machine's (`overrides.issue_tracker`). */
export function issueTracker(at?: TrackerAt): IssueTrackerStrategy {
  const project = at ? projectFor(at) : null;
  return project ? projectTracker(project) : REGISTRY[loadIssueTracker()];
}

/**
 * A new workspace's project (SW-104): `named`, else the one whose scope holds
 * `issueId`, else the `default: true` one. Null on a machine with no projects,
 * or with no issue and no name. Throws when none fits, or when the project's
 * tracker can't read the ref. Scope only picks the project: a named or default
 * one may hold refs outside it.
 */
export function projectForIssue(issueId: string, named = ""): Project | null {
  const projects = loadProjects();
  if (!projects.length) {
    if (named) throw new Error(`--project ${named}: this machine has no projects: in its config`);
    return null;
  }
  const names = projects.map((p) => p.name).join(", ");
  const chosen = named ? projects.find((p) => p.name === named) : undefined;
  if (named && !chosen) throw new Error(`no project "${named}" (projects: ${names})`);
  if (!issueId) return chosen ?? null;
  const project = chosen ?? projectFor({ text: issueId }) ?? defaultProject();
  if (!project)
    throw new Error(`${issueId} isn't in any project's scope; pass --project (one of: ${names})`);
  const tracker = projectTracker(project);
  if (!tracker.parseRef(issueId))
    throw new Error(
      `${issueId} isn't a ${tracker.label} issue in project ${project.name} (e.g. ${tracker.refExample})`,
    );
  return project;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A workspace.yml's project; "" when none. */
export function projectOf(data: Record<string, unknown> | null | undefined): string {
  return str(data?.project);
}

/** A workspace.yml's issue ref: `issue_id`, else the pre-rename `jira_id` / `github_issue`; "" when none. */
export function issueIdOf(data: Record<string, unknown> | null | undefined): string {
  return str(data?.issue_id) || str(data?.jira_id) || str(data?.github_issue);
}

/** A workspace .env's issue ref: `ISSUE_ID`, else the pre-rename `JIRA_ID` / `GITHUB_ISSUE`; "" when none. */
export function issueIdOfMeta(meta: Record<string, string>): string {
  return str(meta["ISSUE_ID"]) || str(meta["JIRA_ID"]) || str(meta["GITHUB_ISSUE"]);
}

/** `[ref, url]` for a workspace's issue from its .env metadata, or null. */
export function issueLink(meta: Record<string, string>): [string, string | null] | null {
  const ref = issueIdOfMeta(meta);
  return ref ? [ref, issueTracker().url(ref)] : null;
}

const MAX_DESCRIPTION = 4000;
const MAX_COMMENTS = 10;
const MAX_COMMENT = 1000;

/**
 * Plain-text briefing of an issue (title, status line, description, recent
 * comments): refine's background context and the form pre-fill's input.
 */
export function issueBriefing(issue: Issue, opts: { full?: boolean } = {}): string {
  const lines: string[] = [`${issue.ref}: ${issue.title ?? "(no title)"}`];
  const meta = [
    issue.status && `Status: ${issue.status}`,
    issue.type && `Type: ${issue.type}`,
    issue.assignee && `Assignee: ${issue.assignee}`,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  if (issue.description) {
    const d = issue.description;
    // SW-324: say so when the cap drops text; `issue view` passes full to print it all.
    const left = opts.full ? 0 : Math.max(0, d.length - MAX_DESCRIPTION);
    lines.push("", "Description:", left ? d.slice(0, MAX_DESCRIPTION) : d);
    if (left) lines.push(`[cut: ${left} more characters not shown]`);
  }
  const comments = issue.comments ?? [];
  if (comments.length) {
    lines.push(
      "",
      `Comments (last ${Math.min(comments.length, MAX_COMMENTS)} of ${comments.length}):`,
    );
    for (const c of comments.slice(-MAX_COMMENTS)) {
      const when = c.created ? ` ${c.created.slice(0, 10)}` : "";
      lines.push(`- [${c.author}${when}] ${c.body.slice(0, MAX_COMMENT)}`);
    }
  }
  return lines.join("\n");
}
