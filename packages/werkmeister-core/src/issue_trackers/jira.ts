/**
 * Jira. REST first (one HTTP call when `jira.api_token` is configured, see
 * docs/jira-rest-setup.md); otherwise a `claude -p` run over the Atlassian MCP
 * the same machine's `claude` has connected.
 */

import { askClaudeJson } from "../claude_cli.js";
import { loadJira, loadSandboxIssuesProject } from "../global_config.js";
import {
  boardColumnRest,
  createIssueRest,
  fetchIssueRest,
  fetchStatusesRest,
  isJiraPlaceholder,
  type JiraRestIssue,
  jiraMyself,
  searchIssuesRest,
  updateIssueRest,
} from "../jira-rest.js";
import type {
  Issue,
  IssueComment,
  IssueKind,
  IssueTrackerStrategy,
  IssueUpdate,
  TrackerScope,
} from "./types.js";

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

const CATEGORIES = ["new", "indeterminate", "done"] as const;
const category = (v: unknown): Issue["statusCategory"] =>
  CATEGORIES.find((c) => c === str(v)?.toLowerCase());

function fromRest(r: JiraRestIssue): Issue {
  const f = r.fields ?? {};
  const comments: IssueComment[] = (f.comment?.comments ?? []).flatMap((c) => {
    const body = c.body?.trim();
    return body ? [{ author: c.author?.displayName ?? "unknown", created: c.created, body }] : [];
  });
  return {
    ref: r.key,
    title: str(f.summary),
    status: str(f.status?.name),
    statusCategory: category(f.status?.statusCategory?.key),
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
      '"title","status","statusCategory" (the status category key: new, indeterminate or done),' +
      ' "type","assignee","description" (strings, "" when unavailable) and ' +
      '"comments" (an array of {"author","created","body"}, oldest first). ' +
      READ_ONLY +
      "\nIf you cannot fetch the issue, output <result>{}</result> and nothing else.",
    { tools: true },
  );
  if (!parsed || !str(parsed.title)) return null;
  const comments = Array.isArray(parsed.comments)
    ? parsed.comments.flatMap((c: unknown) => {
        if (typeof c !== "object" || c === null) return [];
        const r = c as Record<string, unknown>;
        const body = str(r.body);
        return body ? [{ author: str(r.author) ?? "unknown", created: str(r.created), body }] : [];
      })
    : [];
  return {
    ref: key,
    title: str(parsed.title),
    status: str(parsed.status),
    statusCategory: category(parsed.statusCategory),
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
  for (const [k, v] of Object.entries(parsed ?? {})) {
    const status = str(v);
    if (status) out[k.toUpperCase()] = status;
  }
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

/** Wiki markup's specials, escaped inside `{{monospace}}` so `<!--`, `--flag` and `{@link}` stay literal. */
const monoEscape = (code: string) => `{{${code.replace(/([-{}!*_+^~[\]|#])/g, "\\$1")}}}`;

/**
 * Markdown (what agents write, and the issues guide's body templates) as Jira
 * wiki markup, which REST v2 stores verbatim: there `## Ask` is a nested
 * numbered list and `**x**` is not bold. Covers headings, lists, bold, code
 * spans, fenced blocks and links.
 */
// ponytail: line-based, no nesting beyond list indent or tables; prose outside
// code is passed through, so a stray `{x}` or `[x]` can still read as a macro or link.
export function markdownToWiki(md: string): string {
  let fence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      // No language: Jira warns on names it lacks (`sh`, `text`).
      const f = /^\s*(```|~~~)\s*[\w-]*\s*$/.exec(line);
      if (f && (!fence || f[1] === fence)) {
        fence = fence ? null : f[1];
        return "{code}";
      }
      if (fence) return line;
      const inline = (s: string) =>
        s
          .split(/(`[^`]+`)/)
          .map((p) =>
            p.startsWith("`") && p.length > 1
              ? monoEscape(p.slice(1, -1))
              : p
                  .replace(/\*\*(.+?)\*\*/g, "*$1*")
                  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "[$1|$2]"),
          )
          .join("");
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) return `h${h[1].length}. ${inline(h[2])}`;
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, "  ").length / 2) + 1;
        return `${(/\d/.test(li[2]) ? "#" : "*").repeat(depth)} ${inline(li[3])}`;
      }
      return inline(line);
    })
    .join("\n");
}

/** Werkmeister issues go to GitHub unless `overrides.werkmeister_issues_project` names a Jira project; issues_report.ts names it too. */
const WERKMEISTER_ISSUES_REPO = "jbbz-sandbox/werkmeister";

const ISSUE_TYPES: Record<IssueKind, string> = { bug: "Bug", feature: "Story", task: "Task" };

/** Jira, narrowed to `scope.project`'s keys when set (SW-104). The site stays the machine's `jira:` block. */
export function jiraTracker(scope: TrackerScope = {}): IssueTrackerStrategy {
  const key = scope.project?.toUpperCase();
  return {
    id: "jira",
    label: "Jira",
    refExample: "PROJ-123",
    refPattern: null,
    issueTypes: ISSUE_TYPES,
    // The first LETTERS-DIGITS token wins: the key in every Jira URL shape, and in a branch name.
    parseRef: (text) => KEY_RE.exec(text ?? "")?.[0].toUpperCase() ?? null,
    slug: (ref) => ref.trim().toLowerCase(),
    holds: (ref) => !key || ref.toUpperCase().startsWith(`${key}-`),
    url: jiraBrowseUrl,

    async fetchIssue(ref, why) {
      const rest = await fetchIssueRest(ref, why);
      if (rest) return fromRest(rest);
      const mcp = await fetchViaMcp(ref);
      if (!mcp) why?.push("the Atlassian MCP fallback returned no issue");
      return mcp;
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
      const project = /^([A-Z][A-Z0-9]+)-\d+$/.exec(issueId)?.[1] ?? key;
      const sandboxProject = loadSandboxIssuesProject();
      const rawBase = (loadJira().base_url ?? "").trim().replace(/\/+$/, "");
      const site = isJiraPlaceholder(rawBase) || !rawBase ? "" : ` (${rawBase})`;
      const command = (key?: string) =>
        `\`werkmeister issue create --project ${key ?? "<KEY>"} --type <type> --title "<title>" --body-file <file>\`; ` +
        "if it fails for want of a Jira API token, the Atlassian MCP tools if connected, otherwise hand the person the title, type and body to file";
      const jql = (key?: string) =>
        `JQL \`${key ? `project = ${key} AND ` : ""}text ~ "<keywords>"\``;
      const where = `Jira${project ? `, project \`${project}\`` : " — ask the person which project"}${site}`;
      return {
        row: `| app code in a worktree | ${where} | ${command(project)} |`,
        werkmeister: sandboxProject
          ? {
              where: `Jira, project \`${sandboxProject}\`${site}`,
              command: command(sandboxProject),
            }
          : undefined,
        search: `Search first: ${jql(project)}. If it exists, comment on it instead. (Werkmeister issues: ${sandboxProject ? jql(sandboxProject) : `\`gh issue list -R ${WERKMEISTER_ISSUES_REPO} --search "<keywords>" --state all\``}.)`,
      };
    },

    async createIssue({ project, type, title, body }) {
      const created = await createIssueRest({
        project,
        issueType: ISSUE_TYPES[type],
        fallbackLabel: type,
        summary: title,
        description: markdownToWiki(body),
      });
      if (!created)
        throw new Error(
          "no Jira REST credentials: set jira.base_url, jira.email and jira.api_token (docs/jira-rest-setup.md), " +
            "or file it with the Atlassian MCP tools",
        );
      return { ref: created.key, title, type: created.issueType, url: created.url };
    },

    async listReady(board) {
      if (!board && !key) throw new Error("no Jira project in scope");
      const issues = board
        ? await boardColumnRest(board.id, board.ready)
        : await searchIssuesRest(
            `project = ${key} AND statusCategory != Done ORDER BY priority DESC, rank ASC`,
          );
      if (!issues)
        throw new Error("listing ready work needs Jira REST credentials (docs/jira-rest-setup.md)");
      return issues.map(fromRest);
    },

    async updateIssue(ref, update) {
      // The MCP path takes Markdown as-is; only REST v2 needs wiki markup.
      const rest = update.comment ? { ...update, comment: markdownToWiki(update.comment) } : update;
      if ((await updateIssueRest(ref, rest)) === null) await updateViaMcp(ref, update);
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
}

export const jira = jiraTracker();
