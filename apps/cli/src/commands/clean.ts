/**
 * sandbox clean [--all] [--dry-run]
 *
 * Remove orphaned Docker volumes and stale slot entries from stopped
 * features. With --all, also tears down active features first.
 *
 * The sweep itself is `werkmeister-core/lifecycle`; what is left here is the banner
 * and the closing block. The volume lists stay in the library because they
 * interleave with the sweep's own progress — see `runClean`.
 */

import { planClean, runClean } from "werkmeister-core/lifecycle";
import { Colors } from "../lib/config.js";

/** Execute the ``sandbox clean`` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const all = Boolean(args.all);
  const dryRun = Boolean(args.dry_run);

  console.log(`\n${Colors.BOLD}=== sandbox clean ===${Colors.RESET}\n`);

  // planClean is runClean's dry run, named so the non-destructive call is the
  // obvious one to reach for rather than a boolean nobody reads twice.
  await (dryRun ? planClean({ all }) : runClean({ all }));

  console.log(`\n${Colors.GREEN}${Colors.BOLD}=== Clean complete ===${Colors.RESET}\n`);
  if (dryRun) {
    console.log(
      `  ${Colors.DIM}This was a dry run. Re-run without --dry-run to apply changes.${Colors.RESET}`,
    );
  }
  console.log();
}
