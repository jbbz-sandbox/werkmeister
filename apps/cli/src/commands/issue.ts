/**
 * werkmeister issue <view|update> [ref] [--json] [--status <name>] [--comment <text>]
 * werkmeister issue create --project <key> --type <bug|feature|task> --title <text> --body-file <path|->
 * werkmeister issue start
 * werkmeister issue ready [--project <name>] [--json]
 *
 * Read or update one issue in this machine's issue tracker (`werkmeister setup`
 * picks it). Every call goes through `issueTracker()`, so nothing here names a
 * tracker.
 *
 * view:   print the issue's briefing (`--json`: the Issue as JSON).
 * update: move its status and/or add a comment; at least one is required.
 * create: file a new issue and print its URL. Only trackers with an API path
 *         (Jira); GitHub issues are filed with `gh issue create`.
 * start:  inside a workspace, the first stage or phase began: move its issue to
 *         in progress, forward only (docs/workspace-lifecycle.md § Issue status).
 *         Exits 0 when the tracker refuses, so a stage never fails on it.
 * ready:  a project's open work in priority order: its board's ready column in
 *         board rank, else the scope's open issues (SW-104). The project is
 *         --project, else the workspace's, else the default one, else the only one.
 *
 * `ref` may be omitted inside a workspace: the issue is then read from its
 * `.werkmeister/workspace.yml` (the workspace is the folder under a configured
 * workspace root that holds CWD).
 */

import * as fs from "node:fs";

import { findWorkspaceRoot } from "werkmeister-core/gate";
import { candidateWorkspaceRoots } from "werkmeister-core/global_config";
import { startIssue } from "werkmeister-core/issue_status";
import {
  defaultProject,
  type Issue,
  type IssueKind,
  issueBriefing,
  issueIdOf,
  issueTracker,
  type NewIssue,
  projectOf,
  trackerById,
} from "werkmeister-core/issue_tracker";
import { loadProjects } from "werkmeister-core/projects";
import { loadConfigFile } from "werkmeister-core/workspace_prompts";

import { error, success, warn } from "../lib/config.js";

/** The update to send, or the reason the arguments are unusable. */
export function updateFromArgs(
  args: Record<string, unknown>,
): { status?: string; comment?: string } | string {
  const status = (args.status as string | null) || undefined;
  const comment = (args.comment as string | null) || undefined;
  if (!status && !comment)
    return "Nothing to update: pass --status <name> and/or --comment <text>.";
  return { status, comment };
}

const KINDS: readonly IssueKind[] = ["bug", "feature", "task"];

/** The issue to file, or the reason the arguments are unusable. `--body-file -` reads stdin. */
export function newIssueFromArgs(
  args: Record<string, unknown>,
  read: (path: string | 0) => string = (p) => fs.readFileSync(p, "utf8"),
): NewIssue | string {
  const project = ((args.project as string | null) ?? "").trim().toUpperCase();
  const type = (args.type as string | null) ?? "";
  const title = ((args.title as string | null) ?? "").trim();
  const bodyFile = (args.bodyFile as string | null) ?? "";
  if (!project) return "Pass --project <key> (the Jira project to file in).";
  if (!(KINDS as readonly string[]).includes(type))
    return `Pass --type ${KINDS.join("|")} (got '${type}').`;
  if (!title) return "Pass --title <text>.";
  if (!bodyFile) return "Pass --body-file <path> (or - for stdin).";
  let body: string;
  try {
    body = read(bodyFile === "-" ? 0 : bodyFile);
  } catch (e) {
    return `Could not read --body-file ${bodyFile}: ${(e as Error).message}`;
  }
  return { project, type: type as IssueKind, title, body };
}

function fail(msg: string): never {
  error(msg);
  process.exit(1);
}

async function ready(args: Record<string, unknown>): Promise<void> {
  const projects = loadProjects();
  if (!projects.length)
    fail(
      "no project: add one under projects: in ~/.werkmeister/config.yaml (docs/users-guide.md § Projects)",
    );
  const workspace = findWorkspaceRoot(process.cwd(), candidateWorkspaceRoots());
  const name =
    (args.project as string | null) ||
    (workspace === null ? "" : projectOf(loadConfigFile(workspace, null)));
  const project = name
    ? projects.find((p) => p.name === name)
    : (defaultProject() ?? (projects.length === 1 ? projects[0] : undefined));
  const names = projects.map((p) => p.name).join(", ");
  if (!project)
    fail(name ? `no project '${name}' (one of: ${names})` : `pass --project (one of: ${names})`);
  let issues: Issue[];
  try {
    issues = await issueTracker({ project: project.name }).listReady(project.board);
  } catch (e) {
    fail(`Could not list ready work in ${project.name}: ${(e as Error).message}`);
  }
  if (args.json) console.log(JSON.stringify(issues, null, 2));
  else if (!issues.length) success(`Nothing ready in ${project.name}.`);
  else for (const i of issues) console.log(`${i.ref}  ${i.status ?? ""}  ${i.title ?? ""}`);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action === "ready") return ready(args);
  if (args.action === "create") {
    // A Jira project's key files through Jira even when the machine's tracker is GitHub (SW-104).
    const key = String(args.project ?? "").toUpperCase();
    const tracker = loadProjects().some((p) => p.tracker === "jira" && p.scope.project === key)
      ? trackerById("jira")
      : issueTracker();
    if (!tracker.createIssue)
      fail(
        `${tracker.label} issues are filed with its own CLI: gh issue create -R <owner>/<repo>.`,
      );
    const issue = newIssueFromArgs(args);
    if (typeof issue === "string") fail(issue);
    try {
      const created = await tracker.createIssue(issue);
      success(`Created ${created.ref} (${created.type}).`);
      console.log(created.url ?? created.ref);
    } catch (e) {
      fail(`Could not create the issue in ${issue.project}: ${(e as Error).message}`);
    }
    return;
  }
  if (args.action === "start") {
    const workspace = findWorkspaceRoot(process.cwd(), candidateWorkspaceRoots());
    if (workspace === null)
      fail("Not inside a workspace — run this from a workspace folder or below.");
    const line = (await startIssue(workspace)) || "left as is (no in_progress status configured)";
    (line.includes("not moved") ? warn : success)(`Issue: ${line}`);
    return;
  }
  const update = args.action === "update" ? updateFromArgs(args) : null;
  if (typeof update === "string") fail(update);

  let text = (args.ref as string | null) ?? "";
  let project = "";
  if (!text) {
    const workspace = findWorkspaceRoot(process.cwd(), candidateWorkspaceRoots());
    if (workspace === null) {
      fail("No issue given and not inside a workspace.");
    }
    const cfg = loadConfigFile(workspace, null);
    text = issueIdOf(cfg);
    project = projectOf(cfg);
    if (!text)
      fail(
        "No issue given and this workspace has no issue (issue_id in .werkmeister/workspace.yml).",
      );
  }
  const tracker = issueTracker({ project, text });
  const ref = tracker.parseRef(text);
  if (!ref) fail(`'${text}' is not a ${tracker.label} issue ID (e.g. ${tracker.refExample}).`);

  if (update) {
    try {
      await tracker.updateIssue(ref, update);
    } catch (e) {
      fail(`Could not update ${ref}: ${(e as Error).message}`);
    }
    const what = [
      update.status && `status → ${update.status}`,
      update.comment && "comment added",
    ].filter(Boolean);
    success(`Updated ${ref}: ${what.join(", ")}.`);
    return;
  }

  const why: string[] = [];
  const issue = await tracker.fetchIssue(ref, why);
  if (!issue)
    fail(`Could not read ${ref} from ${tracker.label}${why.length ? `: ${why.join("; ")}` : ""}.`);
  console.log(args.json ? JSON.stringify(issue, null, 2) : issueBriefing(issue));
}
