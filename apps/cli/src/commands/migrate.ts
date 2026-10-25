/**
 * werkmeister migrate [--workspaces] [--check]
 *
 * One-shot move of ~/.sandbox to ~/.werkmeister (SW-92), repointing every file
 * that carries the old path. Safe to re-run; refuses while containers that the
 * move would break are running.
 */

import { migrate } from "werkmeister-core/migrate";
import { Colors, success, warn } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const check = Boolean(args.check);
  const steps = await migrate({ checkOnly: check, workspaces: Boolean(args.workspaces) });
  for (const step of steps) {
    const mark = step.ok ? `${Colors.GREEN}✓${Colors.RESET}` : `${Colors.RED}✗${Colors.RESET}`;
    console.log(`${mark} ${step.label}: ${step.detail}`);
  }
  if (steps.some((s) => !s.ok)) {
    warn(check ? "Migration would not complete." : "Migration did not complete.");
    process.exit(1);
  }
  success(check ? "Nothing written (--check)." : "Migrated to ~/.werkmeister.");
}
