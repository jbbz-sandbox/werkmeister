/**
 * sandbox issue <view|update> [ref] [--json] [--status <name>] [--comment <text>]
 *
 * Read or update one issue in this machine's issue tracker (`sandbox setup`
 * picks it). Every call goes through `issueTracker()`, so nothing here names a
 * tracker.
 *
 * view:   print the issue's briefing (`--json`: the Issue as JSON).
 * update: move its status and/or add a comment; at least one is required.
 *
 * `ref` may be omitted inside a workspace: the issue is then read from its
 * `.sandbox/workspace.yml` (the workspace root is the nearest `.sandbox/`
 * above CWD).
 */

import { findWorkspaceRoot } from "sandbox-core/gate";
import { issueBriefing, issueIdOf, issueTracker } from "sandbox-core/issue_tracker";
import { loadConfigFile } from "sandbox-core/workspace_prompts";

import { error, success } from "../lib/config.js";

/** The update to send, or the reason the arguments are unusable. */
export function updateFromArgs(args: Record<string, unknown>): { status?: string; comment?: string } | string {
  const status = (args.status as string | null) || undefined;
  const comment = (args.comment as string | null) || undefined;
  if (!status && !comment) return "Nothing to update: pass --status <name> and/or --comment <text>.";
  return { status, comment };
}

function fail(msg: string): never {
  error(msg);
  process.exit(1);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const tracker = issueTracker();
  const update = args.action === "update" ? updateFromArgs(args) : null;
  if (typeof update === "string") fail(update);

  let text = (args.ref as string | null) ?? "";
  if (!text) {
    const workspace = findWorkspaceRoot(process.cwd());
    if (workspace === null) {
      fail("No issue given and not inside a sandbox workspace (no .sandbox/ directory found above CWD).");
    }
    text = issueIdOf(loadConfigFile(workspace, null));
    if (!text) fail("No issue given and this workspace has no issue (issue_id in .sandbox/workspace.yml).");
  }
  const ref = tracker.parseRef(text);
  if (!ref) fail(`'${text}' is not a ${tracker.label} issue ID (e.g. ${tracker.refExample}).`);

  if (update) {
    try {
      await tracker.updateIssue(ref, update);
    } catch (e) {
      fail(`Could not update ${ref}: ${(e as Error).message}`);
    }
    const what = [update.status && `status → ${update.status}`, update.comment && "comment added"].filter(Boolean);
    success(`Updated ${ref}: ${what.join(", ")}.`);
    return;
  }

  const issue = await tracker.fetchIssue(ref);
  if (!issue) fail(`Could not read ${ref} from ${tracker.label}.`);
  console.log(args.json ? JSON.stringify(issue, null, 2) : issueBriefing(issue));
}
