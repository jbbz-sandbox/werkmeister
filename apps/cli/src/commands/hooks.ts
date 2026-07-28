/**
 * sandbox hooks gate — PreToolUse standards gate
 * (2026-07-18-pretooluse-standards-gate-design.md).
 *
 * CLI-registered path (`sandbox hooks gate`; manual runs, tests). The actual
 * per-edit hook installed in a workspace's `.claude/settings.json` is
 * special-cased by the `./sandbox` wrapper to exec the gate module directly,
 * bypassing the normal entrypoint — the gate module is dependency-light so
 * both paths run the identical logic.
 */

import { main as gateMain } from "../lib/gate.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action === "gate") {
    gateMain();
  }
}
