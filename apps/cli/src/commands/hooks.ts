/**
 * sandbox hooks gate — PreToolUse gate (docs/jit-context-system.md §6).
 *
 * CLI-registered path (`sandbox hooks gate`; manual runs, tests), dispatched to
 * the workspace's strategy. The per-edit hook jit installs is special-cased by
 * the `./sandbox` wrapper to exec the gate module directly, bypassing this —
 * only jit installs that hook, so the fast path stays jit's.
 */

import { findWorkspaceRoot } from "sandbox-core/gate";
import { strategyFor } from "sandbox-core/strategies";

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action !== "gate") {
    return;
  }
  let strategy;
  try {
    strategy = strategyFor(findWorkspaceRoot(process.cwd()) ?? process.cwd());
  } catch {
    return; // a hook must never block the tool call
  }
  strategy.gate();
}
