/**
 * The workspace's own copy of its issue (`.sandbox/issue.md`): fetched once at
 * creation, refreshed only by `sandbox init-workspace --refresh-issue`. The
 * source of record the brief and CLAUDE.md point at (docs/context-strategies.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { issueTracker, type IssueComment, type TrackerId } from "./issue_tracker.js";
import type { IssueRef } from "./strategies/types.js";

export const ISSUE_COPY = ".sandbox/issue.md";

export interface IssueSnapshot {
  ref: string;
  url: string | null;
  tracker: TrackerId;
  title: string;
  status: string;
  body: string;
  comments: IssueComment[];
  /** ISO time the copy was taken. */
  fetchedAt: string;
}

export class IssueFetchError extends Error {}

export async function fetchIssueSnapshot(ref: string, now: () => Date = () => new Date()): Promise<IssueSnapshot> {
  const tracker = issueTracker();
  const issue = await tracker.fetchIssue(ref);
  if (!issue) throw new IssueFetchError(`couldn't read ${ref} from ${tracker.label}`);
  return {
    ref: issue.ref,
    url: issue.url ?? tracker.url(issue.ref),
    tracker: tracker.id,
    title: issue.title ?? "",
    status: issue.status ?? "",
    body: issue.description ?? "",
    comments: issue.comments ?? [],
    fetchedAt: now().toISOString(),
  };
}

const COMMENTS = "\n\n## Comments\n";

export function renderIssueCopy(s: IssueSnapshot): string {
  const head = [
    "---",
    `ref: ${s.ref}`,
    `url: ${s.url ?? ""}`,
    `tracker: ${s.tracker}`,
    `status: ${s.status}`,
    `fetched: ${s.fetchedAt}`,
    "---",
    "",
    `# ${s.title}`,
    "",
    s.body,
  ].join("\n");
  const comments = s.comments.map((c) => `\n### ${c.author} · ${c.created ?? ""}\n\n${c.body}\n`).join("");
  return `${head}${COMMENTS}${comments}`;
}

export function parseIssueCopy(text: string): IssueSnapshot | null {
  const m = /^---\nref: (.*)\nurl: (.*)\ntracker: (.*)\nstatus: (.*)\nfetched: (.*)\n---\n\n# (.*)\n\n/.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  // The renderer always writes the Comments heading before the comment blocks; take the final one.
  // ponytail: splits at the last Comments heading; a comment quoting "\n\n## Comments\n" or a "### a · b" line followed by a blank line would mis-split.
  const at = rest.lastIndexOf(COMMENTS);
  if (at < 0) return null;
  const blocks = rest.slice(at + COMMENTS.length);
  const comments: IssueComment[] = [];
  for (const b of blocks.split(/\n(?=### [^\n]* · [^\n]*\n\n)/).filter((x) => x.trim())) {
    const c = /^\n?### (.*) · (.*)\n\n([\s\S]*?)\n?$/.exec(b);
    if (!c) return null;
    comments.push({ author: c[1], ...(c[2] ? { created: c[2] } : {}), body: c[3] });
  }
  return {
    ref: m[1], url: m[2] || null, tracker: m[3] as TrackerId, status: m[4], fetchedAt: m[5],
    title: m[6], body: rest.slice(0, at), comments,
  };
}

export function writeIssueCopy(root: string, s: IssueSnapshot): void {
  const p = path.join(root, ISSUE_COPY);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderIssueCopy(s));
}

/** What the strategies render: the stored copy (when it is `issueId`'s), else a no-copy ref built from `issueId`, else null. */
export function readIssueRef(root: string, issueId: string): IssueRef | null {
  let s: IssueSnapshot | null = null;
  try {
    s = parseIssueCopy(fs.readFileSync(path.join(root, ISSUE_COPY), "utf8"));
  } catch {
    /* no copy */
  }
  if (s && s.ref === issueId) return { ref: s.ref, url: s.url, title: s.title, fetchedAt: s.fetchedAt };
  if (!issueId) return null;
  return { ref: issueId, url: issueTracker().url(issueId), title: "", fetchedAt: null };
}
