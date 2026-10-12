/**
 * sandbox close-out [name] [--yes]
 *
 * After every PR shipped (or was closed/abandoned): close the issue, write
 * closeout.md to the record branch, remove the workspace, delete the merged
 * code branches. `name` defaults to the workspace the cwd is in. The checks
 * live in sandbox-core's `closeOut`, shared with the pane and the MCP tool.
 */

import path from "node:path";
import { Colors, error, info } from "../lib/config.js";
import { closeOut } from "sandbox-core";
import { findRecordRoot } from "sandbox-core/pr_guard";
import { confirm } from "../lib/wizard.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const root = findRecordRoot(process.cwd());
  const name = (args.name as string | null) ?? (root ? path.basename(root) : null);
  if (!name) {
    error("No workspace given and not inside one.");
    process.exit(1);
  }

  console.log(`\n${Colors.BOLD}=== sandbox close-out: ${name} ===${Colors.RESET}\n`);
  if (!args.yes) {
    console.log(
      `  ${Colors.DIM}Closes the issue, writes closeout.md, removes the workspace, ` +
        `and deletes merged code branches.${Colors.RESET}`,
    );
    if (!(await confirm(`Close out and remove '${name}'?`, false))) {
      info("Aborted -- nothing changed.");
      return;
    }
  }
  const result = await closeOut(name);
  console.log(result.output);
  console.log(`\n${Colors.GREEN}${Colors.BOLD}Workspace '${name}' closed out${Colors.RESET}\n`);
}
