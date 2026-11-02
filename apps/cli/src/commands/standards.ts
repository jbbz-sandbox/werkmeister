/**
 * werkmeister standards check — structural regression gate over the configured
 * standards tree (docs/jit-context-system.md §7).
 *
 * Renders `checkStandards()` and maps any error to exit 1, so a malformed
 * standards edit fails loudly instead of silently dropping out of
 * loadStandardsModules. Separate from `werkmeister skills check`, which is
 * workspace-scoped (projection staleness).
 */

import { checkStandards } from "werkmeister-core/standards";
import { error, info, success } from "../lib/config.js";

export async function run(_args: Record<string, unknown>): Promise<void> {
  const { dir, repoTrees, moduleCount, errors } = checkStandards();

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

  const trees = repoTrees.length ? ` and ${repoTrees.length} repo tree(s)` : "";
  success(
    `${dir}${trees} ${trees ? "are" : "is"} well-formed (${moduleCount} standard module(s) checked).`,
  );
}
