/**
 * The issue-tracker interface. `werkmeister setup` picks one tracker per machine
 * (`overrides.issue_tracker`); every read and write of an issue goes through
 * `issueTracker()` in ../issue_tracker.ts and never names a tracker.
 *
 * Adding a tracker: an id here, a module beside jira.ts / github.ts, and its
 * entry in the registry.
 *
 * No imports, as strategies/types.ts: workspace_prompts.ts reads TRACKER_IDS.
 */

export const TRACKER_IDS = ["jira", "github"] as const;
export type TrackerId = (typeof TRACKER_IDS)[number];

/**
 * A project's slice of its tracker (SW-104): a Jira project key, or a GitHub
 * owner and optionally its repos. `{}` is the machine's whole tracker, as before projects.
 */
export interface TrackerScope {
  project?: string;
  org?: string;
  repos?: string[];
}

/** A board inside the project's tracker: Jira board id, or GitHub Projects number under the scope's org. */
export interface Board {
  id: string;
  /** The column whose items are ready to start; board rank orders them. */
  ready: string;
}

export interface IssueComment {
  author: string;
  /** ISO date, when the tracker gives one. */
  created?: string;
  body: string;
}

/** One issue, as much of it as the tracker returned. `ref` is always set. */
export interface Issue {
  /** The canonical ref: `PROJ-12`, `owner/repo#12`. */
  ref: string;
  title?: string;
  status?: string;
  /** Jira's status category; GitHub: `done` when closed. Where the issue sits, whatever the status is named. */
  statusCategory?: "new" | "indeterminate" | "done";
  /** GitHub labels, where its `status:` label lives. */
  labels?: string[];
  type?: string;
  assignee?: string;
  description?: string;
  url?: string;
  comments?: IssueComment[];
}

export interface IssueUpdate {
  /** The status to move the issue to, by name. */
  status?: string;
  /** A comment to add. */
  comment?: string;
}

export type IssueKind = "bug" | "feature" | "task";

/** An issue to file: `type` is the issues guide's type, mapped to the tracker's own. */
export interface NewIssue {
  /** Where to file it, in the tracker's terms (a Jira project key). */
  project: string;
  type: IssueKind;
  title: string;
  body: string;
}

/** Whether this machine can read issues; `fix` is the one command or doc that repairs it. */
export interface TrackerAuth {
  ok: boolean;
  who?: string;
  reason?: string;
  fix: string;
}

export interface IssueTrackerStrategy {
  readonly id: TrackerId;
  /** The tracker's name in prose and buttons: `Jira`, `GitHub`. */
  readonly label: string;
  /** What a ref looks like, for prompts and placeholders: `PROJ-123`. */
  readonly refExample: string;
  /** The tracker's own name for each issue type in the filing guide, when it has types (GitHub uses labels). */
  readonly issueTypes?: Record<IssueKind, string>;
  /** A regex the form and wizard hold a typed ref to, or null for any text. */
  readonly refPattern: string | null;
  /** The first ref in `text` (a bare id, a short form, a URL, a branch name, a PR body), canonical; null when none. */
  parseRef(text: string): string | null;
  /** The ref as a workspace-name prefix: `PROJ-12` → `proj-12`. */
  slug(ref: string): string;
  /** Whether a canonical ref is in this tracker's scope; always true when unscoped. */
  holds(ref: string): boolean;
  /** The issue's web page, or null when it cannot be built from config. */
  url(ref: string): string | null;
  /** One issue with its description and comments. Null when it cannot be read; never throws. */
  fetchIssue(ref: string): Promise<Issue | null>;
  /** Many issues at once (title, status, url at least). Refs it cannot read are left out; never throws. */
  fetchIssues(refs: string[]): Promise<Record<string, Issue>>;
  /**
   * The issues guide's routing: the "Where" table's app-code row, the
   * search-first step, and where and how to file werkmeister issues when this
   * tracker takes those too (absent: GitHub). `issueId` is the workspace's own issue, "" when none.
   */
  filingGuide(issueId: string): {
    row: string;
    search: string;
    werkmeister?: { where: string; command: string };
  };
  /**
   * File a new issue; it comes back with its ref and url. Absent when agents
   * file with the tracker's own CLI (GitHub: `gh issue create`). Throws with the tracker's reason.
   */
  createIssue?(issue: NewIssue): Promise<Issue>;
  /**
   * Open work in priority order: `board`'s ready column in board rank when given,
   * else the scope's open issues. Throws with the tracker's reason.
   */
  listReady(board?: Board): Promise<Issue[]>;
  /** Move the issue's status and/or add a comment. Throws with the tracker's reason. */
  updateIssue(ref: string, update: IssueUpdate): Promise<void>;
  /** Whether this machine can read issues, and the one command or doc that fixes it. Never throws. */
  checkAuth(): Promise<TrackerAuth>;
}
