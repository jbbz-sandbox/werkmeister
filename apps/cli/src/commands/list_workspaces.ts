/**
 * sandbox list-workspaces
 *
 * The workspaces under $SANDBOX_WORKSPACES_ROOT with their issue and
 * labels. The scan is `werkmeister-core`'s `listWorkspaces` -- the same call the
 * dashboard and the MCP surface make; what is left here is the table.
 */

import { listWorkspaces } from "werkmeister-core";
import { Colors } from "../lib/config.js";

export async function run(_args: Record<string, unknown>): Promise<void> {
  const { root, workspaces } = await listWorkspaces();

  console.log(`\n${Colors.BOLD}=== Workspaces in ${root} ===${Colors.RESET}\n`);

  if (!workspaces.length) {
    console.log(
      `  ${Colors.DIM}No workspaces. Create one with: sandbox workspace <feature>${Colors.RESET}\n`,
    );
    return;
  }

  console.log(
    `  ${Colors.BOLD}${"Workspace".padEnd(32)}  ${"Issue".padEnd(12)}  Labels${Colors.RESET}`,
  );
  console.log(`  ${"─".repeat(70)}`);

  for (const { name, issueId, labels } of workspaces) {
    // padEnd counts escape sequences, so the coloured placeholder is padded by
    // hand -- the same reason services.ts spells its Source cells out.
    const issueCell = issueId
      ? issueId.padEnd(12)
      : `${Colors.DIM}--${Colors.RESET}${" ".repeat(10)}`;
    console.log(
      `  ${name.padEnd(32)}  ${issueCell}  ${Colors.DIM}${labels.join(", ")}${Colors.RESET}`,
    );
  }

  console.log();
  console.log(`  ${Colors.DIM}End one with: sandbox close-out <name>${Colors.RESET}`);
  console.log();
}
