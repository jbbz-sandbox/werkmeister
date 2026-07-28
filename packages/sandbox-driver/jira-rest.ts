/**
 * Direct Jira Cloud REST access via a personal API token — the fast path for
 * data-only Jira reads (status pills, issue cards, refine briefings), replacing
 * multi-second `claude -p` → Atlassian-MCP round-trips with ~200ms HTTP calls.
 *
 * Credentials come from the `jira:` section of ~/.sandbox/config.yaml (the
 * machine-global single source of truth), overridable per-process via
 * JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN. Every export is best-effort and
 * returns null when credentials are absent or a call fails, so callers degrade
 * to the claude-CLI path: the token is an optimization, not a requirement.
 *
 * API v2 on purpose: it returns description/comment bodies as plain
 * wiki-markup strings; v3 returns ADF JSON we'd have to walk.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as YAML from "yaml";

export interface JiraCreds {
  baseUrl: string;
  email: string;
  token: string;
}

/** Placeholder the setup report treats as "not filled in yet". */
const UNFILLED_TOKEN = "PASTE_TOKEN_HERE";

/**
 * Which YAML holds the config — `SANDBOX_CONFIG_FILE` names a *location*, not a
 * value, matching the CLI's `lib/global_config.configPath()`. Duplicated rather
 * than imported: the dashboard and the CLI are separate workspace packages with
 * no build-time dependency between them.
 */
function configPath(): string {
  return process.env.SANDBOX_CONFIG_FILE || path.join(os.homedir(), ".sandbox", "config.yaml");
}

function normalizeCreds(baseUrl: string, email: string, token: string): JiraCreds | null {
  // Linear trailing-slash strip; `/\/+$/` triggers a backtracking lint.
  let trimmed = baseUrl.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  if (!trimmed || !email || !token || token === UNFILLED_TOKEN) return null;
  return { baseUrl: trimmed, email, token };
}

/**
 * Resolve Jira credentials: process env first (per-process override), then the
 * `jira:` section of ~/.sandbox/config.yaml. Re-read per call (one small file
 * read, dwarfed by the network call) so a token paste/renewal takes effect
 * without a server restart.
 */
export async function jiraCreds(): Promise<JiraCreds | null> {
  const fromEnv = normalizeCreds(
    process.env.JIRA_BASE_URL ?? "",
    process.env.JIRA_EMAIL ?? "",
    process.env.JIRA_API_TOKEN ?? "",
  );
  if (fromEnv) return fromEnv;
  try {
    const cfg = YAML.parse(await fs.readFile(configPath(), "utf-8")) as Record<string, any> | null;
    const jira = cfg?.jira ?? {};
    return normalizeCreds(
      String(jira.base_url ?? ""),
      String(jira.email ?? ""),
      String(jira.api_token ?? ""),
    );
  } catch {
    return null;
  }
}

/** GET a Jira REST path (already query-encoded). Throws on HTTP/network failure. */
async function jiraGet<T>(creds: JiraCreds, restPath: string): Promise<T> {
  const res = await fetch(`${creds.baseUrl}${restPath}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.email}:${creds.token}`).toString("base64"),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Jira REST ${restPath} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The v2 issue subset we read. Rich-text fields are plain strings in v2. */
export interface JiraRestIssue {
  key: string;
  fields: {
    summary?: string;
    description?: string | null;
    status?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string } | null;
    comment?: { comments?: Array<{ author?: { displayName?: string }; body?: string; created?: string }> };
  };
}

const ISSUE_FIELDS = "summary,description,status,issuetype,assignee,comment";

/** Fetch one issue (summary/description/status/type/assignee/comments). Null on any failure. */
export async function fetchIssueRest(key: string): Promise<JiraRestIssue | null> {
  const creds = await jiraCreds();
  if (!creds) return null;
  try {
    return await jiraGet<JiraRestIssue>(
      creds,
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    );
  } catch {
    return null;
  }
}

/**
 * Batch status lookup: `{ KEY: statusName }`. Returns null when the REST path
 * is unusable (no creds / request failed) so the caller falls back to claude;
 * a successful search simply omits keys Jira didn't return.
 */
export async function fetchStatusesRest(keys: string[]): Promise<Record<string, string> | null> {
  if (!keys.length) return {};
  const creds = await jiraCreds();
  if (!creds) return null;
  const jql = encodeURIComponent(`key in (${keys.join(",")})`);
  try {
    const data = await jiraGet<{ issues?: Array<{ key?: string; fields?: { status?: { name?: string } } }> }>(
      creds,
      `/rest/api/2/search/jql?jql=${jql}&fields=status&maxResults=100`,
    );
    const out: Record<string, string> = {};
    for (const issue of data.issues ?? []) {
      const name = issue.fields?.status?.name;
      if (issue.key && name) out[issue.key.toUpperCase()] = name;
    }
    return out;
  } catch {
    return null;
  }
}

const MAX_DESCRIPTION = 4000;
const MAX_COMMENTS = 10;
const MAX_COMMENT = 1000;

/**
 * Plain-text ticket briefing (summary, status line, description, recent
 * comments) — the REST-built equivalent of what the claude-CLI extractor used
 * to write, consumed as refine background context and as the form-prefill
 * distillation input.
 */
export function briefingFromIssue(issue: JiraRestIssue): string {
  const f = issue.fields ?? {};
  const lines: string[] = [`${issue.key}: ${f.summary ?? "(no summary)"}`];
  const meta = [
    f.status?.name && `Status: ${f.status.name}`,
    f.issuetype?.name && `Type: ${f.issuetype.name}`,
    f.assignee?.displayName && `Assignee: ${f.assignee.displayName}`,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  if (f.description?.trim()) {
    lines.push("", "Description:", f.description.trim().slice(0, MAX_DESCRIPTION));
  }
  const comments = (f.comment?.comments ?? []).filter((c) => c.body?.trim());
  if (comments.length) {
    lines.push("", `Comments (last ${Math.min(comments.length, MAX_COMMENTS)} of ${comments.length}):`);
    for (const c of comments.slice(-MAX_COMMENTS)) {
      const who = c.author?.displayName ?? "unknown";
      const when = c.created ? ` ${c.created.slice(0, 10)}` : "";
      lines.push(`- [${who}${when}] ${c.body!.trim().slice(0, MAX_COMMENT)}`);
    }
  }
  return lines.join("\n");
}
