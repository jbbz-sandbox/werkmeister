/**
 * werkmeister skills <check|sync>
 *
 * Freshness control for the workspace's context layer: `check` and `sync` are
 * the workspace strategy's (`werkmeister-core/strategies`). For jit that is the
 * w9r-* skills projected into `.claude/skills/` plus the gate manifest; for
 * icm, `_shared/standards.md` and the stage contracts.
 *
 * check: run the workspace strategy's check — a fresh rendering diffed against
 *       what's on disk; exit 1 with a per-entry report when stale.
 * sync:  run the workspace strategy's sync — rewrite whatever check reported
 *       as drifted.
 *
 * Run from anywhere inside a workspace — the workspace is the folder under a
 * configured workspace root that holds CWD.
 */

import { findWorkspaceRoot } from "werkmeister-core/gate";
import { candidateWorkspaceRoots } from "werkmeister-core/global_config";
import { strategyFor } from "werkmeister-core/strategies";

import { Colors, error, success } from "../lib/config.js";

function printDrift(entry: string): void {
  console.log(`${Colors.RED}✗ ${entry}${Colors.RESET}`);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const workspace = findWorkspaceRoot(process.cwd(), candidateWorkspaceRoots());
  if (workspace === null) {
    error("Not inside a workspace — run this from a workspace folder or below.");
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
      `${Colors.YELLOW}Context layer lags the werkmeister repo — run ` +
        "`werkmeister skills sync` (or `werkmeister init-workspace`) to refresh." +
        `${Colors.RESET}`,
    );
    process.exit(1);
  }
  success(`Context layer fresh (${strategy.id}).`);
}
