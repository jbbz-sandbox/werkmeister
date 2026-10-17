/**
 * GitHub issues, through the `gh` CLI. Issues are per repo, so a ref is
 * `owner/repo#12`; a bare `repo#12` takes `overrides.github_org` as its owner.
 * GitHub has only open and closed, so a status other than those two becomes a
 * label on the issue, created first since `gh issue edit --add-label` won't (#156).
 */

import { childEnv } from "../claude_cli.js";
import { loadReposConfig } from "../config.js";
import { loadGithubOrg } from "../global_config.js";
import { runAsync } from "../proc.js";
import type { Issue, IssueTrackerStrategy } from "./types.js";

/** `repo#12` or `owner/repo#12`. */
export const GITHUB_ISSUE_PATTERN = "^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+$";

const FULL_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;
const CLOSED = new Set(["closed", "close", "done"]);
const OPEN = new Set(["open", "reopen", "reopened"]);
// Fixed, or `--force` would give the status label a random color on every update.
const STATUS_LABEL_COLOR = "1D76DB";

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

function split(ref: string): [string, string] {
  const m = FULL_RE.exec(ref);
  if (!m) throw new Error(`"${ref}" is not a GitHub issue (owner/repo#n)`);
  return [m[1], m[2]];
}

/** `gh`, or $SANDBOX_GH_BIN (tests point it at a fake). */
export const ghBin = () => process.env.SANDBOX_GH_BIN || "gh";

/** `gh` with its stdout; throws with gh's own message on a non-zero exit. */
async function gh(args: string[]): Promise<string> {
  const r = await runAsync([ghBin(), ...args], { capture: true, env: childEnv(), timeout: 30 });
  if (r.status !== 0)
    throw new Error(r.stderr.trim() || `gh ${args[0]} ${args[1]} exited ${r.status}`);
  return r.stdout;
}

type GhIssue = {
  title?: string;
  state?: string;
  body?: string;
  url?: string;
  labels?: { name: string }[];
  assignees?: { login: string }[];
  comments?: { author?: { login?: string }; createdAt?: string; body?: string }[];
};

const titleCase = (s?: string) => (s ? s[0] + s.slice(1).toLowerCase() : undefined);

function fromGh(ref: string, i: GhIssue): Issue {
  return {
    ref,
    title: i.title?.trim() || undefined,
    status: titleCase(i.state),
    type: i.labels?.map((l) => l.name).join(", ") || undefined,
    assignee: i.assignees?.map((a) => a.login).join(", ") || undefined,
    description: i.body?.trim() || undefined,
    url: i.url,
    comments: (i.comments ?? [])
      .filter((c) => c.body?.trim())
      .map((c) => ({
        author: c.author?.login ?? "unknown",
        created: c.createdAt,
        body: c.body!.trim(),
      })),
  };
}

async function view(ref: string, fields: string): Promise<Issue | null> {
  try {
    const [repo, n] = split(ref);
    return fromGh(
      ref,
      JSON.parse(await gh(["issue", "view", n, "-R", repo, "--json", fields])) as GhIssue,
    );
  } catch {
    return null;
  }
}

export const github: IssueTrackerStrategy = {
  id: "github",
  label: "GitHub",
  refExample: "owner/repo#12",
  refPattern: GITHUB_ISSUE_PATTERN,
  parseRef(text) {
    const ref = normalizeGithubIssue(text ?? "");
    if (FULL_RE.test(ref)) return ref;
    // Inside longer text (a PR body's `Refs: acme/api#12`, an issue URL): the first full ref.
    const url = /github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/.exec(ref);
    if (url) return `${url[1]}#${url[2]}`;
    return /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/.exec(ref)?.[0] ?? null;
  },
  slug: (ref) =>
    (ref.split("/").pop() ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  url(ref) {
    const m = FULL_RE.exec(ref);
    return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
  },

  fetchIssue: (ref) => view(ref, "title,state,body,url,labels,assignees,comments"),

  // ponytail: one `gh issue view` per ref; a GraphQL batch when a dashboard shows dozens.
  async fetchIssues(refs) {
    const issues = await Promise.all(refs.map((r) => view(r, "title,state,url")));
    return Object.fromEntries(issues.filter((i): i is Issue => i !== null).map((i) => [i.ref, i]));
  },

  filingGuide() {
    const repos = githubIssueRepos();
    const where = repos.length
      ? `the GitHub issues of the repo it belongs to — one of ${repos.map((r) => `\`${r}\``).join(", ")}`
      : "that repo's GitHub issues — find it with `git -C <worktree> remote get-url origin`";
    return {
      row: `| app code in a worktree | ${where} | \`gh issue create -R <owner>/<repo> --label <label>\` |`,
      search:
        'Search first: `gh issue list -R <owner>/<repo> --search "<keywords>" --state all`. If it exists, comment on it instead.',
    };
  },

  async updateIssue(ref, update) {
    const [repo, n] = split(ref);
    const status = update.status?.trim();
    if (status) {
      const s = status.toLowerCase();
      if (CLOSED.has(s)) await gh(["issue", "close", n, "-R", repo]);
      else if (OPEN.has(s)) await gh(["issue", "reopen", n, "-R", repo]);
      else {
        await gh(["label", "create", status, "-R", repo, "--color", STATUS_LABEL_COLOR, "--force"]);
        await gh(["issue", "edit", n, "-R", repo, "--add-label", status]);
      }
    }
    if (update.comment) await gh(["issue", "comment", n, "-R", repo, "--body", update.comment]);
  },

  async checkAuth() {
    const run = (args: string[]) =>
      runAsync([ghBin(), ...args], { capture: true, env: childEnv(), timeout: 15 }).catch(
        () => null,
      );
    const s = await run(["auth", "status", "--hostname", "github.com"]);
    if (s?.status !== 0) return { ok: false, reason: "not signed in", fix: "gh auth login" };
    const who = /account (\S+)/.exec(`${s.stdout}${s.stderr}`)?.[1];
    for (const repo of githubIssueRepos()) {
      const v = await run(["repo", "view", repo, "--json", "name"]);
      if (v?.status !== 0)
        return {
          ok: false,
          ...(who ? { who } : {}),
          reason: `can't read ${repo}`,
          fix: "gh auth refresh -s repo",
        };
    }
    return { ok: true, ...(who ? { who } : {}), fix: "" };
  },
};
