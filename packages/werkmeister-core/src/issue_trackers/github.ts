/**
 * GitHub issues, through the `gh` CLI. Issues are per repo, so a ref is
 * `owner/repo#12`; a bare `repo#12` takes `overrides.github_org` as its owner.
 * GitHub has only open and closed, so a status other than those two becomes a
 * label on the issue, created first since `gh issue edit --add-label` won't (#156).
 * A `status:` label replaces the issue's other `status:` labels, so one is present (SW-27).
 */

import { childEnv } from "../claude_cli.js";
import { envVar, loadReposConfig } from "../config.js";
import { loadGithubOrg } from "../global_config.js";
import { runAsync } from "../proc.js";
import type { Issue, IssueTrackerStrategy, TrackerScope } from "./types.js";

/** `repo#12` or `owner/repo#12`. */
export const GITHUB_ISSUE_PATTERN = "^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+$";

const FULL_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;
const CLOSED = new Set(["closed", "close", "done", "completed"]);
const NOT_PLANNED = new Set(["not planned", "abandoned"]);
const STATUS_PREFIX = "status:";
const OPEN = new Set(["open", "reopen", "reopened"]);
// Fixed, or `--force` would give the status label a random color on every update.
const STATUS_LABEL_COLOR = "1D76DB";

/** `repo#12` → `<org>/repo#12`; an issue URL → `owner/repo#12`; else unchanged. */
export function normalizeGithubIssue(ref: string, org = loadGithubOrg()): string {
  const text = ref.trim();
  const url = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(text);
  if (url) return `${url[1]}#${url[2]}`;
  if (/^[^/#]+#\d+$/.test(text)) return org ? `${org}/${text}` : text;
  return text;
}

/** The scope's repos, else `<owner>/<repo>` for every registry repo; `[]` when no GitHub org is configured. */
export function githubIssueRepos(scope: TrackerScope = {}): string[] {
  if (scope.repos?.length) return [...scope.repos].sort();
  const org = scope.org || loadGithubOrg();
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

/** `gh`, or $WERKMEISTER_GH_BIN (tests point it at a fake). */
export const ghBin = () => envVar("GH_BIN") || "gh";

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
    ...(i.state?.toUpperCase() === "CLOSED" ? { statusCategory: "done" as const } : {}),
    labels: i.labels?.map((l) => l.name),
    type: i.labels?.map((l) => l.name).join(", ") || undefined,
    assignee: i.assignees?.map((a) => a.login).join(", ") || undefined,
    description: i.body?.trim() || undefined,
    url: i.url,
    comments: (i.comments ?? []).flatMap((c) => {
      const body = c.body?.trim();
      return body ? [{ author: c.author?.login ?? "unknown", created: c.createdAt, body }] : [];
    }),
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

/** GitHub issues, narrowed to `scope.org` (and `scope.repos` when listed) when set (SW-104). */
export function githubTracker(scope: TrackerScope = {}): IssueTrackerStrategy {
  const org = scope.org || undefined;
  const repos = scope.repos?.map((r) => r.toLowerCase());
  return {
    id: "github",
    label: "GitHub",
    refExample: "owner/repo#12",
    refPattern: GITHUB_ISSUE_PATTERN,
    parseRef(text) {
      const ref = normalizeGithubIssue(text ?? "", org ?? loadGithubOrg());
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
    holds(ref) {
      const repo = FULL_RE.exec(ref)?.[1].toLowerCase();
      if (!repo) return false;
      if (repos?.length) return repos.includes(repo);
      return !org || repo.startsWith(`${org.toLowerCase()}/`);
    },
    url(ref) {
      const m = FULL_RE.exec(ref);
      return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
    },

    fetchIssue: (ref) => view(ref, "title,state,body,url,labels,assignees,comments"),

    // ponytail: one `gh issue view` per ref; a GraphQL batch when a dashboard shows dozens.
    async fetchIssues(refs) {
      const issues = await Promise.all(refs.map((r) => view(r, "title,state,url")));
      return Object.fromEntries(
        issues.filter((i): i is Issue => i !== null).map((i) => [i.ref, i]),
      );
    },

    filingGuide() {
      const repos = githubIssueRepos(scope);
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
        if (CLOSED.has(s)) await gh(["issue", "close", n, "-R", repo, "--reason", "completed"]);
        else if (NOT_PLANNED.has(s))
          await gh(["issue", "close", n, "-R", repo, "--reason", "not planned"]);
        else if (OPEN.has(s)) await gh(["issue", "reopen", n, "-R", repo]);
        else {
          const stale = s.startsWith(STATUS_PREFIX)
            ? ((await view(ref, "labels"))?.labels ?? []).filter(
                (l) => l.toLowerCase().startsWith(STATUS_PREFIX) && l.toLowerCase() !== s,
              )
            : [];
          await gh([
            "label",
            "create",
            status,
            "-R",
            repo,
            "--color",
            STATUS_LABEL_COLOR,
            "--force",
          ]);
          await gh([
            "issue",
            "edit",
            n,
            "-R",
            repo,
            "--add-label",
            status,
            ...(stale.length ? ["--remove-label", stale.join(",")] : []),
          ]);
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
      for (const repo of githubIssueRepos(scope)) {
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
}

export const github = githubTracker();
