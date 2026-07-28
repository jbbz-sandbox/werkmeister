/**
 * sandbox standards check — structural regression gate over the docs/standards/
 * source tree (2026-07-18-standards-structural-regression-gate-design.md).
 *
 * Runs the three source-tree validators and exits non-zero on any error, so a
 * malformed standards edit fails loudly instead of silently dropping out of
 * loadStandardsModules. Separate from `sandbox skills check`, which is
 * workspace-scoped (projection staleness).
 */

import { error, info, loadServices, success } from "../lib/config.js";
import { validateModuleReferences } from "../lib/skill_gen.js";
import {
  loadStandardsModules,
  validateServiceStandards,
  validateStandardModules,
} from "../lib/standards.js";

export async function run(_args: Record<string, unknown>): Promise<void> {
  const modules = loadStandardsModules();
  const errors = [
    ...validateStandardModules(),
    ...validateModuleReferences(modules),
    ...validateServiceStandards(loadServices(), modules),
  ];
  if (errors.length) {
    error(`docs/standards/ has ${errors.length} problem(s):`);
    for (const e of errors) {
      info(`  - ${e}`);
    }
    process.exit(1);
  }
  success(
    `docs/standards/ is well-formed (${Object.keys(modules).length} standard module(s) checked).`,
  );
}
