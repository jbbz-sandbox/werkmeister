/**
 * Pure, dependency-free filter for the workspace list's search box. Lives in
 * `lib/` (not `src/`) so it compiles to plain Node-importable JS via
 * `tsc -p tsconfig.server.json` and is unit-testable without a DOM —
 * `src/workspace-ui.ts` (the shared UI for the browser dashboard, Cowork
 * artifact, and MCP inline view, including its strict-CSP bundle) imports
 * this same source file directly.
 */

/** The subset of WorkspaceEntry this module needs — kept minimal so callers
 * (server-side WorkspaceEntry, browser-side copy) don't have to match exactly. */
export interface SearchableWorkspace {
  name: string;
  issueId?: string | null;
  labels?: string[];
}

export interface RepoPr {
  repo?: string;
  branch?: string;
  title?: string;
  state?: string;
}

export interface FilterWorkspacesOptions {
  /** Issue ID -> status text. */
  statuses?: Record<string, string>;
  /** workspace name -> Claude session state. */
  cstateByWs?: Record<string, { state?: string } | undefined>;
  /** workspace name -> its open PRs. */
  prsByWs?: Record<string, RepoPr[] | undefined>;
}

function haystack(w: SearchableWorkspace, opts: FilterWorkspacesOptions): string {
  const repos = opts.prsByWs?.[w.name] || [];
  const parts = [
    w.name,
    w.issueId || "",
    (w.issueId && opts.statuses?.[w.issueId]) || "",
    opts.cstateByWs?.[w.name]?.state || "",
    ...(w.labels || []),
    ...repos.flatMap((r) => [r.repo, r.branch, r.title, r.state].filter(Boolean) as string[]),
  ];
  return parts.join(" ").toLowerCase();
}

interface ParsedQuery {
  /** Required OR-groups: every group needs >=1 matching term (AND across groups). */
  include: string[][];
  /** Terms that must not appear anywhere in the haystack. */
  exclude: string[];
}

/**
 * Parses `foo -bar baz|qux` into required terms plus an exclusion list.
 * Whitespace-separated tokens are AND-combined; a leading `-` negates a
 * token; `|` inside a token makes it an OR of alternatives (so `-baz|qux`
 * excludes anything containing baz OR qux).
 */
function parseQuery(raw: string): ParsedQuery {
  const include: string[][] = [];
  const exclude: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const negate = token.startsWith("-") && token.length > 1;
    const alts = (negate ? token.slice(1) : token)
      .split("|")
      .map((s) => s.toLowerCase())
      .filter(Boolean);
    if (alts.length === 0) continue;
    if (negate) exclude.push(...alts);
    else include.push(alts);
  }
  return { include, exclude };
}

/**
 * Filter `all` down to entries matching `query` (substring match, terms
 * AND-combined, `-term` excludes, `a|b` ORs) across name/issueId/status/
 * session-state/labels/repo-PR text. Empty/whitespace query returns `all`
 * unchanged. Preserves the original order of `all`.
 */
export function filterWorkspaces<T extends SearchableWorkspace>(
  all: T[],
  query: string,
  opts: FilterWorkspacesOptions = {},
): T[] {
  const q = query.trim();
  if (!q) return all;

  const parsed = parseQuery(q);
  return all.filter((w) => {
    const hay = haystack(w, opts);
    if (parsed.exclude.some((term) => hay.includes(term))) return false;
    return parsed.include.every((alts) => alts.some((term) => hay.includes(term)));
  });
}
