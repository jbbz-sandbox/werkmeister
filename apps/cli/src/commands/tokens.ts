/**
 * werkmeister machine tokens [--remove]
 *
 * List the daemon tokens in ~/.werkmeister/tokens that have no workspace
 * folder, and with --remove delete them (SW-446).
 */

import { workspacesRoot } from "werkmeister-core/config";
import { revokeWorkspaceToken, staleTokens } from "werkmeister-core/workspace_token";
import { Colors, error } from "../lib/config.js";

/** Execute the ``werkmeister machine tokens`` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const root = workspacesRoot();
  let stale: string[];
  try {
    stale = staleTokens(root);
  } catch (e) {
    error(`${(e as Error).message}. Check paths.workspaces_root (now ${root}). Nothing removed.`);
    process.exit(1);
  }

  console.log(`${stale.length} stale token(s) with no workspace under ${root}`);
  for (const name of stale) console.log(`  ${name}`);

  if (!args.remove) {
    if (stale.length) {
      console.log(`\n${Colors.DIM}Dry run: re-run with --remove to delete them.${Colors.RESET}`);
    }
    return;
  }
  for (const name of stale) {
    revokeWorkspaceToken(name);
    console.log(`  removed ${name}`);
  }
  console.log(`\nRemoved ${stale.length} token(s)`);
}
