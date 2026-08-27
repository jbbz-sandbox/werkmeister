/**
 * sandbox standards check — structural regression gate over the configured
 * standards tree (docs/jit-context-system.md §7).
 *
 * Runs the three source-tree validators and exits non-zero on any error, so a
 * malformed standards edit fails loudly instead of silently dropping out of
 * loadStandardsModules. A missing or empty tree is itself a failure: reporting
 * "0 module(s) checked" and exiting 0 would go green exactly when there is
 * nothing to check. Separate from `sandbox skills check`, which is
 * workspace-scoped (projection staleness).
 */

import { error, info, loadServices, success } from "../lib/config.js";
import { standardsDirPath, standardsDirProblem } from "sandbox-core/global_config";
import { validateModuleReferences } from "../lib/skill_gen.js";
import {
  loadStandardsModules,
  validateServiceStandards,
  validateStandardModules,
} from "../lib/standards.js";

export async function run(_args: Record<string, unknown>): Promise<void> {
  // A missing tree used to report "0 module(s) checked" and exit 0 — the worst
  // outcome for a gate, since CI goes green precisely when there is nothing to
  // check. Same for an existing-but-empty tree.
  const problem = standardsDirProblem();
  if (problem) {
    error(problem);
    process.exit(1);
  }

  const modules = loadStandardsModules();
  if (!Object.keys(modules).length) {
    error(`no standard modules found in ${standardsDirPath()}`);
    process.exit(1);
  }

  const errors = [
    ...validateStandardModules(),
    ...validateModuleReferences(modules),
    ...validateServiceStandards(loadServices(), modules),
  ];
  if (errors.length) {
    error(`${standardsDirPath()} has ${errors.length} problem(s):`);
    for (const e of errors) {
      info(`  - ${e}`);
    }
    process.exit(1);
  }
  success(
    `${standardsDirPath()} is well-formed ` +
      `(${Object.keys(modules).length} standard module(s) checked).`,
  );
}
