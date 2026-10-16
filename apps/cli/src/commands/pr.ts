/**
 * sandbox pr <gate|open|status> [repo] [--json]
 * sandbox pr adopt <pr-number|url> [repo] | adopt --no-pr "<reason>" [repo]
 *
 * The workspace's only way to open a PR (docs/workspace-lifecycle.md). Run
 * from anywhere inside a workspace; `repo` is a code worktree's directory name
 * and limits the action to that repo's PR file.
 *   gate    run the pre-PR gate, change nothing
 *   open    gate each `approved` PR file, push, open the PR, record its URL
 *   status  record merged / shipped / closed from GitHub and release tags
 *   adopt   write the PR file for a fix that landed outside the workspace
 */

import { error } from "../lib/config.js";
import { adoptPr, gatePrs, openPrs, refreshPrStatus } from "sandbox-core";
import { findRecordRoot } from "sandbox-core/pr_guard";

export async function run(args: Record<string, unknown>): Promise<void> {
  const ws = findRecordRoot(process.cwd());
  if (!ws) {
    error("Not inside a sandbox workspace (no .sandbox/workspace.yml above the current directory).");
    process.exit(1);
  }
  const repo = (args.repo as string | null) ?? undefined;
  const result =
    args.action === "adopt"
      ? await adoptPr(ws, { pr: (args.pr as string | null) ?? undefined, noPr: (args.noPr as string | null) ?? undefined, repo })
      : args.action === "gate"
        ? await gatePrs(ws, repo)
        : args.action === "open"
          ? await openPrs(ws, repo)
          : { ok: true, ...(await refreshPrStatus(ws)) };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.lines.join("\n"));
  if (!result.ok) process.exit(1);
}
