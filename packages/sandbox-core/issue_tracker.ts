/**
 * Which issue tracker this machine files work and bugs against —
 * `overrides.issue_tracker` in ~/.sandbox/config.yaml, set by `sandbox setup`.
 *
 *   jira   (default) — one ticket key per workspace (`jira_id`), bugs filed in
 *                      that key's Jira project.
 *   github           — issues are per repo, so the tracker spans every repo in
 *                      the services registry (`repos:`), owned by
 *                      `overrides.github_org`. A workspace's ticket is
 *                      `github_issue: <owner>/<repo>#<n>`.
 *
 * Lives in `overrides:` so `sandbox config`, which rebuilds the YAML and keeps
 * overrides verbatim, cannot drop it.
 */

import { loadReposConfig } from "./config.js";
import { load, loadGithubOrg, loadJira } from "./global_config.js";

export const ISSUE_TRACKERS = ["jira", "github"] as const;
export type IssueTracker = (typeof ISSUE_TRACKERS)[number];

export function loadIssueTracker(cfg?: Record<string, any>): IssueTracker {
  return ((cfg ?? load())["overrides"] ?? {})["issue_tracker"] === "github" ? "github" : "jira";
}

/** `<owner>/<repo>` for every registry repo; `[]` when no GitHub org is configured. */
export function githubIssueRepos(): string[] {
  const org = loadGithubOrg();
  if (!org) return [];
  let repos: string[];
  try {
    repos = Object.keys(loadReposConfig());
  } catch {
    repos = [];
  }
  return repos.sort().map((r) => `${org}/${r}`);
}

/** `repo#12` or `owner/repo#12`. */
export const GITHUB_ISSUE_PATTERN = "^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+$";

/** `repo#12` → `<github_org>/repo#12`; an issue URL → `owner/repo#12`; else unchanged. */
export function normalizeGithubIssue(ref: string): string {
  const text = ref.trim();
  const url = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(text);
  if (url) return `${url[1]}#${url[2]}`;
  if (/^[^/#]+#\d+$/.test(text)) {
    const org = loadGithubOrg();
    return org ? `${org}/${text}` : text;
  }
  return text;
}

/** Workspace-name slug for a GitHub ref: `acme/backend#42` → `backend-42`. */
export function githubIssueSlug(ref: string): string {
  return (ref.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Jira browse URL for a key, or null when `jira.base_url` is unset. */
export function jiraBrowseUrl(key: string): string | null {
  const base = (loadJira().base_url ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}/browse/${key}` : null;
}

/**
 * The Jira site as the Atlassian MCP tools address it: `jira.cloud_id`, else
 * the `jira.base_url` hostname (the tools accept a site URL as cloudId), else null.
 */
export function jiraSiteRef(): string | null {
  const jira = loadJira();
  const id = (jira.cloud_id ?? "").trim();
  if (id) return id;
  const base = (jira.base_url ?? "").trim();
  if (!base) return null;
  try {
    return new URL(base.includes("://") ? base : `https://${base}`).hostname || null;
  } catch {
    return null;
  }
}

/** Prompt phrase naming the Jira site for getJiraIssue / searchJiraIssuesUsingJql. */
export function jiraSitePhrase(): string {
  const ref = jiraSiteRef();
  return ref ? `(Atlassian cloud id ${ref})` : "(find the cloud id with getAccessibleAtlassianResources)";
}

/** `[label, url]` for a workspace's ticket from its .env metadata, or null. */
export function issueLink(meta: Record<string, string>): [string, string | null] | null {
  const jiraId = (meta["JIRA_ID"] ?? "").trim();
  if (jiraId) return [jiraId, jiraBrowseUrl(jiraId)];
  const gh = (meta["GITHUB_ISSUE"] ?? "").trim();
  const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(gh);
  if (m) return [gh, `https://github.com/${m[1]}/issues/${m[2]}`];
  return gh ? [gh, null] : null;
}
