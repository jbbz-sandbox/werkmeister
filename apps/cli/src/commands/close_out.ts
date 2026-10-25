/**
 * sandbox close-out [name] [--yes] [--abandon <reason>]
 *
 * The one end-of-workspace verb (docs/workspace-lifecycle.md). Shipped: close
 * the issue, write closeout.md, remove the workspace, delete the merged code
 * branches. --abandon: record why, push every branch and keep them, remove.
 * `name` defaults to the workspace the cwd is in. The checks live in
 * werkmeister-core's `closeOut`, shared with the pane and the MCP tool.
 */

import path from "node:path";
import { closeOut } from "werkmeister-core";
import { findRecordRoot } from "werkmeister-core/pr_guard";
import { Colors, error, info } from "../lib/config.js";
import { confirm } from "../lib/wizard.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const root = findRecordRoot(process.cwd());
  const name = (args.name as string | null) ?? (root ? path.basename(root) : null);
  if (!name) {
    error("No workspace given and not inside one.");
    process.exit(1);
  }
  const abandon = (args.abandon as string | null | undefined) ?? null;

  console.log(`\n${Colors.BOLD}=== sandbox close-out: ${name} ===${Colors.RESET}\n`);
  if (!args.yes) {
    console.log(
      `  ${Colors.DIM}${
        abandon === null
          ? "Closes the issue, writes closeout.md, removes the workspace, and deletes merged code branches."
          : "Records the reason in closeout.md, pushes and keeps every branch with commits of its own, then removes the workspace."
      }${Colors.RESET}`,
    );
    if (
      !(await confirm(
        abandon === null ? `Close out and remove '${name}'?` : `Abandon and remove '${name}'?`,
        false,
      ))
    ) {
      info("Aborted -- nothing changed.");
      return;
    }
  }
  const result = abandon === null ? await closeOut(name) : await closeOut(name, { abandon });
  console.log(result.output);
  console.log(`\n${Colors.GREEN}${Colors.BOLD}Workspace '${name}' closed out${Colors.RESET}`);
  // The CLI can't reach the desktop app; the pane and the close-out MCP tool archive these themselves.
  console.log(
    `  ${Colors.DIM}Archive this workspace's desktop sessions from the Claude sidebar.${Colors.RESET}\n`,
  );
}
