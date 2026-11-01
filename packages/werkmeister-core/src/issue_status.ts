/**
 * The workspace issue's status follows the lifecycle (SW-27, docs/workspace-lifecycle.md
 * § Issue status): In Progress when the first stage starts, In Review at `pr open`, Done at
 * ship. Every move goes through `moveIssue`, which only moves forward (apart from the two
 * backward moves to in_progress) and never throws: a tracker refusal is a warning line.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { load } from "./global_config.js";
import {
  issueIdOf,
  issueTracker,
  loadIssueTracker,
  projectFor,
  projectOf,
  type TrackerAt,
} from "./issue_tracker.js";
import type { Issue, IssueTrackerStrategy, TrackerId } from "./issue_trackers/types.js";
import { isQuestionFile } from "./md_form.js";
import { loadConfigFile } from "./workspace_prompts.js";

export const ISSUE_POINTS = ["in_progress", "in_review", "merged", "done", "abandoned"] as const;
export type IssuePoint = (typeof ISSUE_POINTS)[number];
/** Per point: a Jira status name, a GitHub label (or `closed` / `not planned`), or null to skip. */
export type IssueStatuses = Record<IssuePoint, string | null>;

const DEFAULTS: Record<TrackerId, IssueStatuses> = {
  jira: {
    in_progress: "In Progress",
    in_review: "In Review",
    merged: null,
    done: "Done",
    abandoned: null,
  },
  github: {
    in_progress: "status: in progress",
    in_review: "status: in review",
    merged: null,
    done: "closed",
    abandoned: "not planned",
  },
};

// The flat keys (pre-SW-27, plus SW-24's); honoured when `issue_statuses` doesn't name the point.
const ALIASES: Partial<Record<IssuePoint, string>> = {
  in_progress: "issue_progress_status",
  in_review: "issue_review_status",
  done: "issue_done_status",
};

const RANK: Record<IssuePoint, number> = {
  in_progress: 1,
  in_review: 2,
  merged: 3,
  done: 4,
  abandoned: 4,
};

const blankToNull = (v: unknown): string | null =>
  v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();

/** `overrides.issue_statuses.<point>` (null skips), else its alias, else the tracker's default. */
export function resolveIssueStatuses(
  overrides: Record<string, unknown>,
  tracker: TrackerId,
): IssueStatuses {
  const map = (overrides["issue_statuses"] ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULTS[tracker] };
  for (const point of ISSUE_POINTS) {
    const alias = ALIASES[point];
    if (Object.hasOwn(map, point)) out[point] = blankToNull(map[point]);
    else if (alias && overrides[alias] !== undefined) out[point] = blankToNull(overrides[alias]);
  }
  return out;
}

/** The statuses for `at`: its project's map over its tracker's defaults, else today's overrides. */
export function issueStatuses(at?: TrackerAt): IssueStatuses {
  const project = at ? projectFor(at) : null;
  return project
    ? resolveIssueStatuses({ issue_statuses: project.issueStatuses }, project.tracker)
    : resolveIssueStatuses(load()["overrides"] ?? {}, loadIssueTracker());
}

/** 0 new, 1 in progress, 2 in review, 3 merged, 4 done: from the category, then the names. */
export function issuePosition(issue: Issue, statuses: IssueStatuses): number {
  const names = new Set(
    [issue.status, ...(issue.labels ?? [])].flatMap((n) => (n ? [n.trim().toLowerCase()] : [])),
  );
  const is = (point: IssuePoint) => {
    const s = statuses[point];
    return s !== null && names.has(s.toLowerCase());
  };
  if (issue.statusCategory === "done" || is("done")) return 4;
  if (is("merged")) return 3;
  if (is("in_review")) return 2;
  if (is("in_progress")) return 1;
  return issue.statusCategory === "indeterminate" ? 1 : 0;
}

/**
 * Move *ref* to *point* when that is forward (or *back* from review/merged to in_progress),
 * posting *comment* with the move. Returns one line for the caller's output; never throws.
 * `alwaysComment` posts the comment even when the status is skipped or not forward.
 */
export async function moveIssue(
  tracker: IssueTrackerStrategy,
  ref: string,
  point: IssuePoint,
  statuses: IssueStatuses,
  opts: { comment: string; back?: boolean; alwaysComment?: boolean },
): Promise<string> {
  const status = statuses[point];
  try {
    if (status === null) {
      if (!opts.alwaysComment) return "";
      await tracker.updateIssue(ref, { comment: opts.comment });
      return `${ref} commented (no ${point} status configured)`;
    }
    const why: string[] = [];
    // One retry: a failed read during a long `pr open` was transient both times it was seen (SW-109).
    const issue = (await tracker.fetchIssue(ref, why)) ?? (await tracker.fetchIssue(ref, why));
    // Unread means the position is unknown, and a blind move could drag the issue back.
    if (!issue)
      return (
        `${ref} not moved to "${status}": could not read its current status ` +
        `(${[...new Set(why)].join("; ") || "no reason given"}); move it by hand: ` +
        `werkmeister issue update ${ref} --status ${JSON.stringify(status)} --comment ${JSON.stringify(opts.comment)}`
      );
    const pos = issuePosition(issue, statuses);
    if (!(RANK[point] > pos || (opts.back && pos >= 2 && pos < 4))) {
      if (opts.alwaysComment) await tracker.updateIssue(ref, { comment: opts.comment });
      // GitHub's status is only Open/Closed; the label says where it sits.
      const label = issue.labels?.find((l) =>
        ISSUE_POINTS.some((p) => statuses[p]?.toLowerCase() === l.toLowerCase()),
      );
      return `${ref} already ${issue.status ?? "past that"}${label ? ` (${label})` : ""}`;
    }
    await tracker.updateIssue(ref, { status, comment: opts.comment });
    return `${ref} → ${status}`;
  } catch (e) {
    return `${ref} not moved to "${status ?? point}": ${(e as Error).message}`;
  }
}

/** The first stage whose output/ holds no real file, or the JIT research phase. */
function currentStage(ws: string): string {
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(path.join(ws, "stages"))
      .filter((d) => /^\d+_/.test(d))
      .sort();
  } catch {
    return "research phase";
  }
  const empty = dirs.find((d) => {
    try {
      return !fs
        .readdirSync(path.join(ws, "stages", d, "output"))
        .some((f) => !f.startsWith(".") && !isQuestionFile(f));
    } catch {
      return true;
    }
  });
  return `stage ${empty ?? dirs[0] ?? "01"}`;
}

/** `werkmeister issue start`: the first stage or phase began, so the issue moves to in_progress. */
export async function startIssue(
  ws: string,
  tracker?: IssueTrackerStrategy,
  statuses?: IssueStatuses,
): Promise<string> {
  const cfg = loadConfigFile(ws, null);
  const ref = issueIdOf(cfg);
  if (!ref) return "no issue";
  const at = { project: projectOf(cfg), text: ref };
  tracker ??= issueTracker(at);
  statuses ??= issueStatuses(at);
  return moveIssue(tracker, ref, "in_progress", statuses, {
    comment: `Work started: ${currentStage(ws)} in workspace ${path.basename(ws)}.`,
  });
}
