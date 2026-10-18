/**
 * sandbox remove-workspace <name> [--yes] [--abandon <reason>]
 *
 * Deprecated for one release (#160): `sandbox close-out --abandon` is the
 * public verb, and `removeWorkspace` is the internal step it calls.
 *
 * Hand off and delete a workspace: commit + push every worktree branch, tear
 * the feature down, delete the directory, prune the source repos' worktree
 * registrations.
 *
 * The sequence is `werkmeister-core`'s `removeWorkspace` -- the same call the
 * dashboard and the MCP surface make. What is left here is the confirmation and
 * the summary. The guard that matters stays in core: an unpushable branch
 * aborts the whole teardown, so no surface can delete unpushed work. The
 * prompt is a second line of defence against a mistyped name, which is why
 * --yes exists rather than the prompt being skipped for non-TTY callers.
 * Core also refuses unshipped work (open PR, unmerged commits) unless
 * --abandon records why (docs/workspace-lifecycle.md).
 */

import { removeWorkspace } from "werkmeister-core";
import { Colors, info, warn } from "../lib/config.js";
import { confirm } from "../lib/wizard.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const name = args.name as string;

  warn('sandbox remove-workspace is deprecated — use `sandbox close-out --abandon "<reason>"`');
  console.log(`\n${Colors.BOLD}=== sandbox remove-workspace: ${name} ===${Colors.RESET}\n`);

  if (!args.yes) {
    console.log(
      `  ${Colors.DIM}Pushes every branch, runs sandbox down, then deletes the ` +
        `workspace directory.${Colors.RESET}`,
    );
    if (!(await confirm(`Delete workspace '${name}'?`, false))) {
      info("Aborted -- nothing was deleted.");
      console.log();
      return;
    }
  }

  const result = await removeWorkspace(name, {
    abandon: (args.abandon as string | null) ?? undefined,
  });

  console.log(result.output);
  console.log(`\n${Colors.GREEN}${Colors.BOLD}Workspace '${name}' removed${Colors.RESET}`);
  console.log(`  ${Colors.DIM}${result.path}${Colors.RESET}\n`);
}
