/** Driving an OpenCode session (SW-385): one `opencode run` turn through the shared runner. */
import os from "node:os";
import path from "node:path";
import { type AgentState, agentOf, readSessions } from "../../agent_state.js";
import { isExecutable, shellQuote } from "../../tool_bins.js";
import { runTurn, turnStatus } from "../turn.js";
import type { SessionSignal, TurnOptions, TurnResult } from "../types.js";

/** $OPENCODE_BIN → the usual install locations → bare `opencode` (resolved on childEnv's PATH). */
export async function resolveOpencodeBin(): Promise<string> {
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }
  return "opencode";
}

/** OpenCode names models `provider/model`; a Claude alias like `sonnet` is left to OpenCode's own config. */
const modelArgs = (model: string | null) => (model?.includes("/") ? ["--model", model] : []);

export function opencodeSendArgs(
  body: string,
  sessionId: string | null,
  model: string | null,
  opts: { unattended?: boolean } = {},
): string[] {
  return [
    "run",
    "--format",
    "json",
    ...modelArgs(model),
    ...(sessionId ? ["--session", sessionId] : []),
    // Approves what the config doesn't deny; the plugin's gate and PR guard still block.
    ...(opts.unattended ? ["--auto"] : []),
    body,
  ];
}

export async function startTurn(
  key: string,
  cwd: string,
  body: string,
  sessionId: string | null,
  model: string | null,
  opts: TurnOptions = {},
): Promise<TurnResult | null> {
  const args = opencodeSendArgs(body, sessionId, model, { unattended: Boolean(opts.unattended) });
  const stdout = await runTurn(key, await resolveOpencodeBin(), args, cwd, Boolean(opts.wait));
  // OpenCode's JSON events carry no list of refused calls, unlike claude's permission_denials.
  return stdout === null ? null : { denied: [] };
}

/** A live turn → working; else what the plugin last recorded; else idle. */
export async function sessionSignal(
  key: string,
  dir: string,
  src: { sessionFile: string | null; updatedAt: string | null } | null,
): Promise<{ signal: SessionSignal; lastActivity: string | null }> {
  const lastActivity = src?.updatedAt ?? null;
  const state = turnStatus(key).state;
  const signal = (agent: AgentState, at = lastActivity, question: string | null = null) => ({
    signal: { state, agent, at, question },
    lastActivity,
  });
  if (state === "running") return signal("working");
  const recorded = agentOf(readSessions(dir));
  // A headless `opencode run` exits before the plugin's Stop call finishes (seen on 2.2.5), so
  // a `working` record from that turn would stick; the turn runner knows the turn ended.
  // The record keeps its first `at` while it stays working, so it can predate the last turn.
  // shortcut: an interactive session working after that turn reads done until the daemon restarts or another turn runs; record the turn's end time if that shows up.
  if ((state === "done" || state === "failed") && recorded?.agent === "working")
    return signal(state === "done" ? "done" : "idle", recorded.at);
  if (recorded) return signal(recorded.agent, recorded.at, recorded.question);
  return signal("idle");
}

export function opencodeResumeCommand(
  sessionId: string | null,
  model: string | null,
  prompt?: string,
): string {
  return [
    "opencode",
    ...modelArgs(model).map(shellQuote),
    ...(sessionId ? ["--session", shellQuote(sessionId)] : []),
    ...(prompt ? ["--prompt", shellQuote(prompt)] : []),
  ].join(" ");
}
