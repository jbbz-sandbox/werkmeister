/**
 * werkmeister internal gate — PreToolUse gate (docs/jit-context-system.md §6).
 *
 * CLI-registered path (`werkmeister internal gate`; manual runs, tests), dispatched to
 * the workspace's strategy. The per-edit hook jit installs is special-cased by
 * the `./werkmeister` wrapper to exec the gate module directly, bypassing this —
 * only jit installs that hook, so the fast path stays jit's. `pr-guard` (every
 * strategy) and `agent-state` (every strategy, every tool call) have the same
 * wrapper fast path; this is their manual-run path.
 */

import { main as agentState } from "werkmeister-core/agent_state";
import { findWorkspaceRoot } from "werkmeister-core/gate";
import { candidateWorkspaceRoots } from "werkmeister-core/global_config";
import { main as prGuard } from "werkmeister-core/pr_guard";
import { strategyFor } from "werkmeister-core/strategies";

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action === "pr-guard") {
    prGuard();
    return;
  }
  if (args.action === "agent-state") {
    agentState();
    return;
  }
  if (args.action !== "gate") {
    return;
  }
  let strategy;
  try {
    strategy = strategyFor(
      findWorkspaceRoot(process.cwd(), candidateWorkspaceRoots()) ?? process.cwd(),
    );
  } catch {
    return; // a hook must never block the tool call
  }
  strategy.gate();
}
