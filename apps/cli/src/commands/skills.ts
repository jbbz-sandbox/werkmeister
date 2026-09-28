/**
 * sandbox skills <check|sync>
 *
 * Freshness control for the workspace's context layer: `check` and `sync` are
 * the workspace strategy's (`sandbox-core/strategies`). For jit that is the
 * sb-* skills projected into `.claude/skills/` plus the gate manifest; for
 * icm, `_shared/standards.md` and the stage contracts.
 *
 * check: compare the workspace's projected skills against a fresh rendering
 *       from this repo; exit 1 with a per-skill report when stale.
 * sync:  rewrite the projection (same writer init-workspace uses) and prune
 *       orphaned sb-* skills.
 *
 * Run from anywhere inside a workspace — the workspace root is resolved by
 * walking up to the nearest `.sandbox/` directory.
 */

import { findWorkspaceRoot } from "sandbox-core/gate";
import { strategyFor } from "sandbox-core/strategies";

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
  const strategy = strategyFor(workspace);

  if (args.action === "sync") {
    strategy.sync(workspace);
    return;
  }

  const drift = strategy.check(workspace);
  for (const entry of drift) {
    printDrift(entry);
  }
  if (drift.length) {
    console.log(
      `${Colors.YELLOW}Context layer lags the sandbox repo — run ` +
        "`sandbox skills sync` (or `sandbox init-workspace`) to refresh." +
        `${Colors.RESET}`,
    );
    process.exit(1);
  }
  success(`Context layer fresh (${strategy.id}).`);
}
