/**
 * The issue-tracker registry: which tracker this machine files work and bugs
 * against — `overrides.issue_tracker` in ~/.sandbox/config.yaml, set by
 * `sandbox setup` — and the one door every issue read and write goes through.
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
 * Lives in `overrides:` so `sandbox config`, which rebuilds the YAML and keeps
 * overrides verbatim, cannot drop it.
 */

import { load } from "./global_config.js";
import { github } from "./issue_trackers/github.js";
import { jira } from "./issue_trackers/jira.js";
import { TRACKER_IDS, type Issue, type IssueTrackerStrategy, type TrackerId } from "./issue_trackers/types.js";

export { TRACKER_IDS } from "./issue_trackers/types.js";
export type { Issue, IssueComment, IssueTrackerStrategy, IssueUpdate, TrackerAuth, TrackerId } from "./issue_trackers/types.js";
export { GITHUB_ISSUE_PATTERN, ghBin, githubIssueRepos, normalizeGithubIssue } from "./issue_trackers/github.js";
export { jiraSitePhrase, jiraSiteRef } from "./issue_trackers/jira.js";

const REGISTRY: Record<TrackerId, IssueTrackerStrategy> = { jira, github };

export function trackerById(id: TrackerId): IssueTrackerStrategy {
  return REGISTRY[id];
}

/** The configured tracker's id; anything unrecognised reads as jira. */
export function loadIssueTracker(cfg?: Record<string, any>): TrackerId {
  const id = ((cfg ?? load())["overrides"] ?? {})["issue_tracker"];
  return (TRACKER_IDS as readonly string[]).includes(id) ? (id as TrackerId) : "jira";
}

/** The configured tracker. */
export function issueTracker(cfg?: Record<string, any>): IssueTrackerStrategy {
  return REGISTRY[loadIssueTracker(cfg)];
}


const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

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
export function issueBriefing(issue: Issue): string {
  const lines: string[] = [`${issue.ref}: ${issue.title ?? "(no title)"}`];
  const meta = [
    issue.status && `Status: ${issue.status}`,
    issue.type && `Type: ${issue.type}`,
    issue.assignee && `Assignee: ${issue.assignee}`,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  if (issue.description) lines.push("", "Description:", issue.description.slice(0, MAX_DESCRIPTION));
  const comments = issue.comments ?? [];
  if (comments.length) {
    lines.push("", `Comments (last ${Math.min(comments.length, MAX_COMMENTS)} of ${comments.length}):`);
    for (const c of comments.slice(-MAX_COMMENTS)) {
      const when = c.created ? ` ${c.created.slice(0, 10)}` : "";
      lines.push(`- [${c.author}${when}] ${c.body.slice(0, MAX_COMMENT)}`);
    }
  }
  return lines.join("\n");
}
