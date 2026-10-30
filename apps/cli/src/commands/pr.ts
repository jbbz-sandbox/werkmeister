/**
 * werkmeister pr <gate|open|status> [repo] [--json]
 * werkmeister pr adopt <pr-number|url> [repo] | adopt --no-pr "<reason>" [repo]
 * werkmeister pr new <worktree> --slug <slug>
 *
 * The workspace's only way to open a PR (docs/workspace-lifecycle.md). Run
 * from anywhere inside a workspace; `repo` is a code worktree's directory name
 * and limits the action to that repo's PR files; a PR file's name (`werkmeister-why-page`) limits it to that file.
 *   gate    run the pre-PR gate, change nothing
 *   open    gate each `approved` PR file, push, open the PR, record its URL
 *   status  record merged / shipped / closed from GitHub and release tags
 *   adopt   write the PR file for a fix that landed outside the workspace
 *   new     after a worktree's PR merged: cut a fresh branch from base and write a draft follow-up PR file
 *   watch   from anywhere: resume each terminal session whose PR merged, shipped or closed
 *           (desktop sessions are the werkmeister mod's)
 *   watch --install | --uninstall   add / remove the 10-minute schedule (launchd on macOS, else crontab)
 */

import { adoptPr, gatePrs, newPr, openPrs, refreshPrStatus, watchPrs } from "werkmeister-core";
import { installPrWatchSchedule, uninstallPrWatchSchedule } from "werkmeister-core/machine_setup";
import { findRecordRoot } from "werkmeister-core/pr_guard";
import { error } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.install || args.uninstall) {
    if (args.action !== "watch") {
      error("--install/--uninstall go with `pr watch`.");
      process.exit(1);
    }
    if (args.install && args.uninstall) {
      error("Pick one of --install or --uninstall.");
      process.exit(1);
    }
    return print(args.install ? installPrWatchSchedule() : uninstallPrWatchSchedule(), args);
  }
  if (args.action === "watch") return print(await watchPrs({ desktop: false }), args);
  const ws = findRecordRoot(process.cwd());
  if (!ws) {
    error("Not inside a workspace (no .werkmeister/workspace.yml above the current directory).");
    process.exit(1);
  }
  const repo = (args.repo as string | null) ?? undefined;
  if (args.action === "new" && !(repo && args.slug)) {
    error("Usage: werkmeister pr new <worktree> --slug <slug>");
    process.exit(1);
  }
  const result =
    args.action === "adopt"
      ? await adoptPr(ws, {
          pr: (args.pr as string | null) ?? undefined,
          noPr: (args.noPr as string | null) ?? undefined,
          repo,
        })
      : args.action === "new"
        ? await newPr(ws, repo as string, args.slug as string)
        : args.action === "gate"
          ? await gatePrs(ws, repo, undefined, { wait: args.wait !== false })
          : args.action === "open"
            ? await openPrs(ws, repo, undefined, { wait: args.wait !== false })
            : { ok: true, ...(await refreshPrStatus(ws)) };
  print(result, args);
}

function print(result: { ok: boolean; lines: string[] }, args: Record<string, unknown>): void {
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.lines.join("\n"));
  if (!result.ok) process.exit(1);
}
