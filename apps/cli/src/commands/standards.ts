/**
 * sandbox standards check — structural regression gate over the configured
 * standards tree (docs/jit-context-system.md §7).
 *
 * Renders `checkStandards()` and maps any error to exit 1, so a malformed
 * standards edit fails loudly instead of silently dropping out of
 * loadStandardsModules. Separate from `sandbox skills check`, which is
 * workspace-scoped (projection staleness).
 */

import { error, info, success } from "../lib/config.js";
import { checkStandards } from "sandbox-core/standards";

export async function run(_args: Record<string, unknown>): Promise<void> {
  const { dir, moduleCount, errors } = checkStandards();

  if (errors.length) {
    // A zero module count means the tree itself is unusable (missing, or empty)
    // — one message that stands on its own, rather than a "1 problem(s)" header
    // over a list of one. Anything else is per-module and reads as a list.
    if (!moduleCount) {
      error(errors[0]);
    } else {
      error(`${dir} has ${errors.length} problem(s):`);
      for (const e of errors) {
        info(`  - ${e}`);
      }
    }
    process.exit(1);
  }

  success(`${dir} is well-formed (${moduleCount} standard module(s) checked).`);
}
