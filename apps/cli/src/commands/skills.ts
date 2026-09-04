/**
 * sandbox skills <check|sync>
 *
 * Freshness control for the sb-* skills projected into a workspace's
 * `.claude/skills/` (docs/jit-context-system.md §5 — skills are projected at
 * init-workspace, not shipped via the plugin, so a workspace inited before a
 * standards edit lags until re-synced).
 *
 * check: compare the workspace's projected skills against a fresh rendering
 *       from this repo; exit 1 with a per-skill report when stale.
 * sync:  rewrite the projection (same writer init-workspace uses) and prune
 *       orphaned sb-* skills.
 *
 * The verbs themselves live in sandbox-core/workspace_skills; what is left here
 * is the cwd walk-up, the red ✗ rendering, and the exit code.
 *
 * Run from anywhere inside a workspace — the workspace root is resolved by
 * walking up to the nearest `.sandbox/` directory.
 */

import { findWorkspaceRoot } from "sandbox-core/gate";
import {
  checkSkills,
  checkStandardsManifest,
  syncSkills,
} from "sandbox-core/workspace_skills";

import { Colors, error, success } from "../lib/config.js";

function printDrift(entry: string): void {
  console.log(`${Colors.RED}✗ ${entry}${Colors.RESET}`);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const workspace = findWorkspaceRoot(process.cwd());
  if (workspace === null) {
    error("Not inside a sandbox workspace (no .sandbox/ directory found above CWD).");
    process.exit(1);
  }

  if (args.action === "sync") {
    syncSkills(workspace);
    return;
  }

  const { authoring, drift } = checkSkills(workspace);
  for (const entry of authoring) {
    printDrift(entry);
  }
  for (const entry of drift) {
    printDrift(entry);
  }

  // After the projected-skill report, because resolving the manifest logs.
  const manifestDrift = checkStandardsManifest(workspace);
  if (manifestDrift !== null) {
    printDrift(manifestDrift);
    drift.push(manifestDrift);
  }

  if (drift.length) {
    console.log(
      `${Colors.YELLOW}Workspace skills lag the sandbox repo — run ` +
        "`sandbox skills sync` (or `sandbox init-workspace`) to refresh." +
        `${Colors.RESET}`,
    );
  }
  if (authoring.length || drift.length) {
    process.exit(1);
  }
  success("Workspace sb-* skills are current.");
}
