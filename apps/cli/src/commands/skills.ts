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

import { SandboxError } from "werkmeister-core/errors";
import { findWorkspaceRoot } from "werkmeister-core/gate";
import { candidateWorkspaceRoots } from "werkmeister-core/global_config";
import { strategyFor, TEMPLATE_CHANGED } from "werkmeister-core/strategies";

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

  // SW-1143: a malformed `stages:` entry throws while rendering; print it as init does, not raw.
  let drift: string[];
  try {
    if (args.action === "sync") {
      strategy.sync(workspace);
      return;
    }
    drift = strategy.check(workspace);
  } catch (e) {
    if (!(e instanceof SandboxError)) throw e;
    error(e.message);
    process.exit(1);
  }
  for (const entry of drift) {
    printDrift(entry);
  }
  if (drift.length) {
    const template = drift.find((e) => e.startsWith(`${TEMPLATE_CHANGED}: `));
    if (template) {
      console.log(
        `${Colors.YELLOW}Workflow template ${template.slice(TEMPLATE_CHANGED.length + 2)} ` +
          "changed since init — run `werkmeister skills sync` to re-render its stage contracts." +
          `${Colors.RESET}`,
      );
    }
    // _shared/ is never rendered from a template, so its drift is werkmeister's even beside a template change.
    if (!template || drift.some((e) => e.startsWith("_shared/"))) {
      console.log(
        `${Colors.YELLOW}Context layer lags the werkmeister repo` +
          // SW-190 renders services' `stages:` from the live registry, so a `registry sync` drifts every workspace.
          (drift.some((e) => e.startsWith("stages/"))
            ? " — or a service's `stages:` text in the registry changed (`werkmeister registry sync`)"
            : "") +
          " — run " +
          "`werkmeister skills sync` (or `werkmeister workspace init`) to refresh." +
          `${Colors.RESET}`,
      );
    }
    process.exit(1);
  }
  success(`Context layer fresh (${strategy.id}).`);
}
