/** Driving an OpenCode session (SW-385): one `opencode run` turn through the shared runner. */
import os from "node:os";
import path from "node:path";
import { isFixture } from "../../config.js";
import { fixtureOpencodeBin, isExecutable, shellQuote } from "../../tool_bins.js";
import { signalFrom } from "../sessions.js";
import { runTurn } from "../turn.js";
import type { SessionSignal, TurnOptions, TurnResult } from "../types.js";

/** $OPENCODE_BIN → the usual install locations → bare `opencode` (resolved on childEnv's PATH). */
export async function resolveOpencodeBin(): Promise<string> {
  if (isFixture()) return fixtureOpencodeBin();
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

/**
 * The workspace list's agent signal ({@link signalFrom}), with a finished turn overriding a
 * stuck `working` record. No session file, so no transcript tail: without a record, idle.
 */
export function sessionSignal(
  key: string,
  dir: string,
  src: { sessionFile: string | null; updatedAt: string | null } | null,
): Promise<{ signal: SessionSignal; lastActivity: string | null }> {
  return signalFrom(key, dir, src, () => [], { staleWorking: true });
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
