/**
 * Jira. REST first (one HTTP call when `jira.api_token` is configured, see
 * docs/jira-rest-setup.md); otherwise a `claude -p` run over the Atlassian MCP
 * the same machine's `claude` has connected.
 */

import { askClaudeJson } from "../claude_cli.js";
import { loadJira } from "../global_config.js";
import {
  fetchIssueRest,
  fetchStatusesRest,
  isJiraPlaceholder,
  type JiraRestIssue,
  jiraMyself,
  updateIssueRest,
} from "../jira-rest.js";
import type { Issue, IssueComment, IssueTrackerStrategy, IssueUpdate } from "./types.js";

const KEY_RE = /[A-Za-z][A-Za-z0-9]+-\d+/;

/** Jira browse URL for a key, or null when `jira.base_url` is unset. */
export function jiraBrowseUrl(key: string): string | null {
  const base = (loadJira().base_url ?? "").trim().replace(/\/+$/, "");
  if (!base || isJiraPlaceholder(base)) return null;
  return `${base.includes("://") ? base : `https://${base}`}/browse/${key}`;
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
  if (!base || isJiraPlaceholder(base)) return null;
  try {
    return new URL(base.includes("://") ? base : `https://${base}`).hostname || null;
  } catch {
    return null;
  }
}

/** Prompt phrase naming the Jira site for getJiraIssue / searchJiraIssuesUsingJql. */
export function jiraSitePhrase(): string {
  const ref = jiraSiteRef();
  return ref
    ? `(Atlassian cloud id ${ref})`
    : "(find the cloud id with getAccessibleAtlassianResources)";
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function fromRest(r: JiraRestIssue): Issue {
  const f = r.fields ?? {};
  const comments: IssueComment[] = (f.comment?.comments ?? [])
    .filter((c) => c.body?.trim())
    .map((c) => ({
      author: c.author?.displayName ?? "unknown",
      created: c.created,
      body: c.body!.trim(),
    }));
  return {
    ref: r.key,
    title: str(f.summary),
    status: str(f.status?.name),
    type: str(f.issuetype?.name),
    assignee: str(f.assignee?.displayName),
    description: str(f.description),
    url: jiraBrowseUrl(r.key) ?? undefined,
    comments,
  };
}

const READ_ONLY =
  "Do not create, edit, transition, or comment on anything; write no prose outside the tags.";

async function fetchViaMcp(key: string): Promise<Issue | null> {
  const parsed = await askClaudeJson(
    "You are a data extractor, not an agent. Do exactly two things and nothing else:\n" +
      `1. Fetch Jira issue ${key} INCLUDING ITS COMMENTS using getJiraIssue ${jiraSitePhrase()} — request ` +
      'fields ["summary","status","issuetype","assignee","description","comment"].\n' +
      "2. Output ONLY a JSON object between <result> and </result> tags with keys " +
      '"title","status","type","assignee","description" (strings, "" when unavailable) and ' +
      '"comments" (an array of {"author","created","body"}, oldest first). ' +
      READ_ONLY +
      "\nIf you cannot fetch the issue, output <result>{}</result> and nothing else.",
    { tools: true },
  );
  if (!parsed || !str(parsed.title)) return null;
  const comments = Array.isArray(parsed.comments)
    ? parsed.comments
        .filter(
          (c): c is Record<string, unknown> => typeof c === "object" && c !== null && !!str(c.body),
        )
        .map((c) => ({
          author: str(c.author) ?? "unknown",
          created: str(c.created),
          body: str(c.body)!,
        }))
    : [];
  return {
    ref: key,
    title: str(parsed.title),
    status: str(parsed.status),
    type: str(parsed.type),
    assignee: str(parsed.assignee),
    description: str(parsed.description),
    url: jiraBrowseUrl(key) ?? undefined,
    comments,
  };
}

async function statusesViaMcp(keys: string[]): Promise<Record<string, string>> {
  const parsed = await askClaudeJson(
    "You are a data extractor, not an agent. Do exactly two things and nothing else:\n" +
      `1. Run searchJiraIssuesUsingJql ${jiraSitePhrase()} with jql ` +
      `'key in (${keys.join(",")})' and fields ["status"].\n` +
      "2. Output ONLY a JSON object between <result> and </result> tags mapping each issue key " +
      'to its status name, e.g. {"PROJ-1234":"In Progress"}. Omit keys you could not fetch. ' +
      READ_ONLY +
      "\nIf the search fails entirely, output <result>{}</result> and nothing else.",
    { tools: true },
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed ?? {})) if (str(v)) out[k.toUpperCase()] = str(v)!;
  return out;
}

async function updateViaMcp(key: string, update: IssueUpdate): Promise<void> {
  const steps = [
    update.status &&
      `Transition Jira issue ${key} to the status "${update.status}" with transitionJiraIssue.`,
    update.comment &&
      `Add this comment to Jira issue ${key} with addCommentToJiraIssue, verbatim:\n${update.comment}`,
  ].filter(Boolean);
  const parsed = await askClaudeJson(
    `Do exactly this on the Jira site ${jiraSitePhrase()} and nothing else:\n` +
      steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
      '\nThen output ONLY <result>{"ok":true}</result>, or <result>{"ok":false,"error":"<why>"}</result> ' +
      "when any step failed. Write no prose outside the tags.",
    { tools: true },
  );
  if (parsed?.ok !== true)
    throw new Error(str(parsed?.error) ?? `Could not update ${key} through the Atlassian MCP`);
}

/** Sandbox-tool issues always go to GitHub, whatever the tracker; issues_report.ts names it too. */
const SANDBOX_ISSUES_REPO = "jbbz-sandbox/sandbox";

export const jira: IssueTrackerStrategy = {
  id: "jira",
  label: "Jira",
  refExample: "PROJ-123",
  refPattern: null,
  issueTypes: { bug: "Bug", feature: "Story", task: "Task" },
  // The first LETTERS-DIGITS token wins: the key in every Jira URL shape, and in a branch name.
  parseRef: (text) => KEY_RE.exec(text ?? "")?.[0].toUpperCase() ?? null,
  slug: (ref) => ref.trim().toLowerCase(),
  url: jiraBrowseUrl,

  async fetchIssue(ref) {
    const rest = await fetchIssueRest(ref);
    return rest ? fromRest(rest) : fetchViaMcp(ref);
  },

  async fetchIssues(refs) {
    if (!refs.length) return {};
    const statuses = (await fetchStatusesRest(refs)) ?? (await statusesViaMcp(refs));
    const out: Record<string, Issue> = {};
    for (const [ref, status] of Object.entries(statuses))
      out[ref] = { ref, status, url: jiraBrowseUrl(ref) ?? undefined };
    return out;
  },

  filingGuide(issueId) {
    const project = /^([A-Z][A-Z0-9]+)-\d+$/.exec(issueId)?.[1];
    const rawBase = (loadJira().base_url ?? "").trim().replace(/\/+$/, "");
    const base = isJiraPlaceholder(rawBase) ? "" : rawBase;
    const where = `Jira${project ? `, project \`${project}\`` : " — ask the person which project"}${base ? ` (${base})` : ""}`;
    return {
      row: `| app code in a worktree | ${where} | the Atlassian MCP tools if connected, with the Jira issue type from the type table; otherwise hand the person the title, type and body to file |`,
      search: `Search first: JQL \`${project ? `project = ${project} AND ` : ""}text ~ "<keywords>"\`. If it exists, comment on it instead. (Sandbox-tool issues: \`gh issue list -R ${SANDBOX_ISSUES_REPO} --search "<keywords>" --state all\`.)`,
    };
  },

  async updateIssue(ref, update) {
    if ((await updateIssueRest(ref, update)) === null) await updateViaMcp(ref, update);
  },

  async checkAuth() {
    const fix = "set jira.base_url, jira.email and jira.api_token (docs/jira-rest-setup.md)";
    try {
      const me = await jiraMyself();
      if (me) return { ok: true, who: me.who, fix: "" };
      // No REST creds: fetchIssue still works through the Atlassian MCP, so only placeholder values are a fault.
      const j = loadJira();
      const values = [
        process.env.JIRA_BASE_URL,
        process.env.JIRA_EMAIL,
        process.env.JIRA_API_TOKEN,
        j.base_url,
        j.email,
        j.api_token,
      ];
      return values.some((v) => v && isJiraPlaceholder(String(v)))
        ? { ok: false, reason: "Jira settings still hold the placeholder values", fix }
        : { ok: true, who: "via Atlassian MCP (not checked)", fix: "" };
    } catch (e) {
      return { ok: false, reason: (e as Error).message, fix };
    }
  },
};
