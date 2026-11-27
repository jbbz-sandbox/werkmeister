/**
 * The issue-tracker interface. `werkmeister machine setup` picks one tracker per machine
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

/**
 * A board inside the project's tracker: Jira board id, or GitHub Projects number under the scope's org.
 *
 * @example
 * ```ts
 * import { type Board, issueTracker } from "werkmeister-core/sdk";
 *
 * const board: Board = { id: "1", ready: "To Do" };
 * for (const issue of await issueTracker().listReady(board)) console.log(issue.ref, issue.title);
 * ```
 */
export interface Board {
  /** The Jira board id, or the GitHub Projects number. */
  id: string;
  /** The column whose items are ready to start; board rank orders them. */
  ready: string;
}

/**
 * One comment on an issue.
 *
 * @example
 * ```ts
 * import { type IssueComment, issueTracker } from "werkmeister-core/sdk";
 *
 * const issue = await issueTracker().fetchIssue("PROJ-42");
 * const comments: IssueComment[] = issue?.comments ?? [];
 * for (const c of comments) console.log(c.author, c.created ?? "", c.body);
 * ```
 */
export interface IssueComment {
  /** Who wrote it, as the tracker names them. */
  author: string;
  /** ISO date, when the tracker gives one. */
  created?: string;
  /** The comment text. */
  body: string;
}

/**
 * One issue from Jira or GitHub, with as much as the tracker returned. Only
 * `ref` is always set; the rest is absent when the tracker did not send it.
 *
 * @example
 * ```ts
 * import { type Issue, issueTracker } from "werkmeister-core/sdk";
 *
 * const issue: Issue | null = await issueTracker({ text: "PROJ-12" }).fetchIssue("PROJ-12");
 * if (issue) console.log(`${issue.ref} [${issue.status ?? "?"}] ${issue.title ?? ""}`);
 * ```
 */
export interface Issue {
  /** The canonical ref: `PROJ-12`, `owner/repo#12`. */
  ref: string;
  /** The issue's summary line. */
  title?: string;
  /** The tracker's own status name, e.g. `In Progress`; GitHub: `Open` or `Closed`. */
  status?: string;
  /** Jira's status category; GitHub: `done` when closed. Where the issue sits, whatever the status is named. */
  statusCategory?: "new" | "indeterminate" | "done";
  /** GitHub labels, where its `status:` label lives. */
  labels?: string[];
  /** Jira's issue type name, e.g. `Bug`; GitHub: the labels, comma-joined. */
  type?: string;
  /** Jira: the display name; GitHub: assignee logins, comma-joined. Absent when unassigned. */
  assignee?: string;
  /** The issue body as text; absent when empty or not fetched. */
  description?: string;
  /** The issue's web page. */
  url?: string;
  /** The comments, oldest first, each with `author`, `body` and maybe `created`; absent when not fetched. */
  comments?: IssueComment[];
  /** The parent issue (a Jira epic), when it has one; absent otherwise. */
  parent?: IssueParent;
}

/**
 * An issue's parent, where a child's context often lives (an epic's linked review).
 *
 * @example
 * ```ts
 * import { type IssueParent, issueTracker } from "werkmeister-core/sdk";
 *
 * const issue = await issueTracker().fetchIssue("PROJ-42");
 * const parent: IssueParent | undefined = issue?.parent;
 * if (parent) console.log(`part of ${parent.ref}: ${parent.title ?? ""}`);
 * ```
 */
export interface IssueParent {
  /** The parent's ref, e.g. `PROJ-1`. */
  ref: string;
  /** The parent's summary line. */
  title?: string;
  /** The parent's web page. */
  url?: string;
  /** The parent's body as text; absent when it could not be fetched. */
  description?: string;
}

/**
 * A change to make to an issue: a new status, a comment, or both.
 *
 * @example
 * ```ts
 * import { type IssueUpdate, issueTracker } from "werkmeister-core/sdk";
 *
 * const update: IssueUpdate = { status: "In Review", comment: "PR opened." };
 * await issueTracker().updateIssue("PROJ-42", update);
 * ```
 */
export interface IssueUpdate {
  /** The status to move the issue to, by name. */
  status?: string;
  /** A comment to add. */
  comment?: string;
}

/**
 * The kind of issue to file: a bug, a feature or a task. Each tracker maps it to its own type.
 *
 * @example
 * ```ts
 * import { type IssueKind, issueTracker } from "werkmeister-core/sdk";
 *
 * const kind: IssueKind = "bug";
 * console.log(issueTracker().issueTypes?.[kind] ?? kind);
 * ```
 */
export type IssueKind = "bug" | "feature" | "task";

/**
 * An issue to file: `type` is the issues guide's type, mapped to the tracker's own.
 *
 * @example
 * ```ts
 * import { issueTracker, type NewIssue } from "werkmeister-core/sdk";
 *
 * const issue: NewIssue = { project: "PROJ", type: "bug", title: "Login fails", body: "Steps..." };
 * const filed = await issueTracker().createIssue?.(issue);
 * if (filed) console.log(filed.ref, filed.url);
 * ```
 */
export interface NewIssue {
  /** Where to file it, in the tracker's terms (a Jira project key). */
  project: string;
  /** What kind of issue it is. */
  type: IssueKind;
  /** The summary line. */
  title: string;
  /** The description. */
  body: string;
}

/**
 * Whether this machine can read issues; `fix` is the one command or doc that repairs it.
 *
 * @example
 * ```ts
 * import { issueTracker, type TrackerAuth } from "werkmeister-core/sdk";
 *
 * const auth: TrackerAuth = await issueTracker().checkAuth();
 * console.log(auth.ok ? `signed in as ${auth.who}` : `${auth.reason}: run ${auth.fix}`);
 * ```
 */
export interface TrackerAuth {
  /** The tracker can be read from this machine. */
  ok: boolean;
  /** Who is signed in, when `ok`. */
  who?: string;
  /** Why it can't be read, when not `ok`. */
  reason?: string;
  /** The command or doc that repairs it. */
  fix: string;
}

/**
 * One issue tracker (Jira or GitHub): parse issue refs, build links, and read,
 * move, comment on and file issues. Get one from {@link issueTracker}. The
 * methods that return a Promise call the tracker over the network, in-process;
 * the others only read the config.
 *
 * @example
 * ```ts
 * import { issueTracker, type IssueTrackerStrategy } from "werkmeister-core/sdk";
 *
 * const tracker: IssueTrackerStrategy = issueTracker();
 * const ref = tracker.parseRef("feature/PROJ-42-login");
 * if (ref) await tracker.updateIssue(ref, { comment: "Picked up." });
 * ```
 */
export interface IssueTrackerStrategy {
  /** The tracker's id, `"jira"` or `"github"`: the value `overrides.issue_tracker` in the config selects it by. */
  readonly id: TrackerId;
  /** The tracker's name in prose and buttons: `Jira`, `GitHub`. */
  readonly label: string;
  /** What a ref looks like, for prompts and placeholders: `PROJ-123`. */
  readonly refExample: string;
  /** The tracker's own name for each of `bug`, `feature` and `task`; absent when it has no issue types (GitHub uses labels). */
  readonly issueTypes?: Record<IssueKind, string>;
  /** A regular expression a typed ref must match, or null when any text goes. */
  readonly refPattern: string | null;
  /** The first ref in `text` (a bare id, a short form, a URL, a branch name, a PR body), canonical; null when none. */
  parseRef(text: string): string | null;
  /** The ref as a workspace-name prefix: `PROJ-12` → `proj-12`. */
  slug(ref: string): string;
  /** Whether a canonical ref is in this tracker's scope; always true when unscoped. */
  holds(ref: string): boolean;
  /** The issue's web page, or null when it cannot be built from config. */
  url(ref: string): string | null;
  /**
   * One issue with its description and comments. Null when it cannot be read, with the reasons pushed onto `why`. Never throws.
   * `withParent` also reads the parent's description (one more request): only where the parent is shown.
   */
  fetchIssue(ref: string, why?: string[], opts?: { withParent?: boolean }): Promise<Issue | null>;
  /** Many issues at once (title, status, url at least). Refs it cannot read are left out; never throws. */
  fetchIssues(refs: string[]): Promise<Record<string, Issue>>;
  /**
   * Markdown that tells an agent where to file a bug and how to search for an
   * existing one first. `issueId` is the workspace's own issue ("" when none)
   * and `workspace` its name; both go into the search queries.
   */
  filingGuide(
    issueId: string,
    workspace?: string,
  ): {
    /** The "Where" table's markdown row for bugs in app code: where they go and the command that files them. */
    row: string;
    /** The search-first step as one markdown paragraph, with the queries to run. */
    search: string;
    /** Where bugs in werkmeister itself go; absent when they go to GitHub instead. */
    werkmeister?: {
      /** The tracker and project, in prose. */
      where: string;
      /** The filing command, as markdown. */
      command: string;
    };
  };
  /**
   * Files a new issue (`project`, `type`, `title`, `body`) and resolves with
   * its ref and url. Absent on GitHub, where you file with `gh issue create`.
   * Rejects with the tracker's reason.
   */
  createIssue?(issue: NewIssue): Promise<Issue>;
  /** Links `ref` "relates to" `to`. Only trackers with `createIssue` have it. Rejects with the tracker's reason. */
  linkIssue?(ref: string, to: string): Promise<void>;
  /**
   * Open issues in priority order: the given board's ready column (`{ id, ready }`)
   * in board order, else every open issue the tracker covers. Rejects with the tracker's reason.
   */
  listReady(board?: Board): Promise<Issue[]>;
  /** Moves the issue to `update.status` (by name) and/or adds `update.comment`. Rejects with the tracker's reason. */
  updateIssue(ref: string, update: IssueUpdate): Promise<void>;
  /** Whether this machine can read issues: `ok` and `who` is signed in, else `reason` and `fix`, the command or doc that repairs it. Never throws. */
  checkAuth(): Promise<TrackerAuth>;
}
