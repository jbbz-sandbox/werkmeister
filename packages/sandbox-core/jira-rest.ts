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
import { loadConfig } from "./config.js";

export interface JiraCreds {
  baseUrl: string;
  email: string;
  token: string;
}

/** Paste-me values from the config template: "not filled in yet". */
export const JIRA_PLACEHOLDERS = new Set(["PASTE_TOKEN_HERE", "<your-atlassian-login-email>", "https://your-org.atlassian.net"]);
export const isJiraPlaceholder = (v: string): boolean => JIRA_PLACEHOLDERS.has(v.trim().replace(/\/+$/, ""));

function normalizeCreds(baseUrl: string, email: string, token: string): JiraCreds | null {
  // Linear trailing-slash strip; `/\/+$/` triggers a backtracking lint.
  let trimmed = baseUrl.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  if (!trimmed || !email || !token || isJiraPlaceholder(trimmed) || isJiraPlaceholder(email) || isJiraPlaceholder(token)) return null;
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
    const jira = loadConfig()["jira"] ?? {};
    return normalizeCreds(
      String(jira.base_url ?? ""),
      String(jira.email ?? ""),
      String(jira.api_token ?? ""),
    );
  } catch {
    return null;
  }
}

/** A Jira REST call (path already query-encoded). Throws on HTTP/network failure. */
async function jiraFetch(creds: JiraCreds, restPath: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${creds.baseUrl}${restPath}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.email}:${creds.token}`).toString("base64"),
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Jira REST ${restPath} → HTTP ${res.status}`);
  return res;
}

/** Who the configured token signs in as; null without usable creds. Throws on HTTP failure. */
export async function jiraMyself(): Promise<{ who: string } | null> {
  const creds = await jiraCreds();
  if (!creds) return null;
  const r = await jiraFetch(creds, "/rest/api/3/myself");
  const j = (await r.json()) as { emailAddress?: string; displayName?: string };
  return { who: j.emailAddress ?? j.displayName ?? creds.email };
}

async function jiraGet<T>(creds: JiraCreds, restPath: string): Promise<T> {
  return (await (await jiraFetch(creds, restPath)).json()) as T;
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


/**
 * Move an issue to the status named `status` (case-insensitive, matched on the
 * transition's target status, then its own name) and/or add a comment. Null
 * when no credentials are configured, so the caller can fall back; throws when
 * Jira refuses or no transition reaches `status`.
 */
export async function updateIssueRest(key: string, update: { status?: string; comment?: string }): Promise<true | null> {
  const creds = await jiraCreds();
  if (!creds) return null;
  const path = `/rest/api/2/issue/${encodeURIComponent(key)}`;
  if (update.status) {
    const want = update.status.trim().toLowerCase();
    const { transitions = [] } = await jiraGet<{ transitions?: Array<{ id: string; name?: string; to?: { name?: string } }> }>(
      creds,
      `${path}/transitions`,
    );
    const t =
      transitions.find((x) => x.to?.name?.toLowerCase() === want) ?? transitions.find((x) => x.name?.toLowerCase() === want);
    if (!t) {
      const names = transitions.map((x) => x.to?.name ?? x.name).filter(Boolean).join(", ");
      throw new Error(`${key} has no transition to "${update.status}" (available: ${names || "none"})`);
    }
    await jiraFetch(creds, `${path}/transitions`, { transition: { id: t.id } });
  }
  if (update.comment) await jiraFetch(creds, `${path}/comment`, { body: update.comment });
  return true;
}
