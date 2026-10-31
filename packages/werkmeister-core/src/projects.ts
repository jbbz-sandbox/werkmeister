/**
 * Projects (SW-104): `projects:` in ~/.werkmeister/config.yaml names tracking
 * strategies — a tracker with its scope, an optional board, and status names —
 * so one machine can work on a Jira-tracked product and a GitHub-tracked one.
 * A workspace picks one with `project:` in workspace.yml; issue_tracker.ts
 * resolves through it. No `projects:` is today's single machine-wide tracker.
 *
 *   projects:
 *     werkmeister:
 *       tracker: { id: jira, project: SW }
 *       board: { id: 42, ready: Selected for Development }
 *       issue_statuses: { in_review: In Review }
 *       default: true
 *     acme:
 *       tracker: { id: github, org: acme, repos: [acme/web] }
 */

import type { GlobalConfig } from "./config.js";
import { load } from "./global_config.js";
import {
  type Board,
  TRACKER_IDS,
  type TrackerId,
  type TrackerScope,
} from "./issue_trackers/types.js";
import { warn } from "./reporter.js";

export type { Board };

export interface Project {
  name: string;
  tracker: TrackerId;
  scope: TrackerScope;
  board?: Board;
  /** Raw `issue_statuses` map; issue_status.ts resolves it against the tracker's defaults. */
  issueStatuses: Record<string, unknown>;
  default: boolean;
}

/** Same as workspace.schema.json's `project`. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v).trim() : "";

/** One project, or why it is invalid. */
function parse(name: string, raw: unknown): Project | string {
  if (!NAME_RE.test(name)) return "name must be lowercase letters, digits and single hyphens";
  if (!isDict(raw)) return "must be a map";
  const t = isDict(raw.tracker) ? raw.tracker : {};
  const id = str(t.id);
  if (!(TRACKER_IDS as readonly string[]).includes(id))
    return `tracker.id must be one of ${TRACKER_IDS.join(", ")}`;
  const scope: TrackerScope = {};
  if (id === "jira") {
    const key = str(t.project).toUpperCase();
    if (!JIRA_KEY_RE.test(key)) return "tracker.project must be a Jira project key (e.g. SW)";
    scope.project = key;
  } else {
    const org = str(t.org);
    if (!org) return "tracker.org must name the GitHub owner";
    scope.org = org;
    if (t.repos !== undefined) {
      const repos = Array.isArray(t.repos) ? t.repos.map(str) : [];
      if (!repos.length || !repos.every((r) => REPO_RE.test(r)))
        return "tracker.repos must be a list of owner/repo";
      scope.repos = repos;
    }
  }
  let board: Board | undefined;
  if (raw.board !== undefined) {
    const b = isDict(raw.board) ? raw.board : {};
    // No default column: which one means "ready" is the person's call (SW-104 Q3).
    if (!str(b.id) || !str(b.ready)) return "board needs both id and ready";
    board = { id: str(b.id), ready: str(b.ready) };
  }
  if (raw.issue_statuses !== undefined && !isDict(raw.issue_statuses))
    return "issue_statuses must be a map";
  return {
    name,
    tracker: id as TrackerId,
    scope,
    ...(board ? { board } : {}),
    issueStatuses: isDict(raw.issue_statuses) ? raw.issue_statuses : {},
    default: raw.default === true,
  };
}

function parseAll(cfg: GlobalConfig): { projects: Project[]; problems: string[] } {
  const raw = cfg["projects"];
  const projects: Project[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { projects, problems };
  if (!isDict(raw)) return { projects, problems: ["projects: must be a map of name → project"] };
  for (const name of Object.keys(raw).sort()) {
    const p = parse(name, raw[name]);
    if (typeof p === "string") problems.push(`projects.${name}: ${p}`);
    else projects.push(p);
  }
  const defaults = projects.filter((p) => p.default).map((p) => p.name);
  if (defaults.length > 1)
    problems.push(`projects: only one project may set default: true (${defaults.join(", ")})`);
  return { projects, problems };
}

/** Each invalid project as "projects.<name>: <why>"; [] when none or no `projects:`. */
export function projectProblems(cfg?: GlobalConfig): string[] {
  return parseAll(cfg ?? load()).problems;
}

const warned = new Set<string>();

/** The valid projects, sorted by name; [] when the machine has none. Invalid ones warn once and are left out. */
export function loadProjects(cfg?: GlobalConfig): Project[] {
  const { projects, problems } = parseAll(cfg ?? load());
  for (const p of problems) {
    if (warned.has(p)) continue;
    warned.add(p);
    warn(`${p} — skipped (werkmeister machine config --check)`);
  }
  return projects;
}
