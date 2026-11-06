/**
 * Driving a Codex session (SW-384): one headless `codex exec` turn per `claude-send`
 * through the shared runner, the workspace list's agent signal and the terminal
 * resume command.
 */
import { shellQuote } from "../../tool_bins.js";
import { signalFrom } from "../sessions.js";
import { runTurn } from "../turn.js";
import type { SessionSignal, TurnOptions, TurnResult } from "../types.js";
import { resolveCodexBin } from "./cli.js";
import { CODEX_LAUNCH } from "./index.js";
import { parseCodexLines } from "./transcript.js";

/**
 * `codex` argv for one headless turn, always with `sandbox_mode` workspace-write: `exec resume`
 * takes no `-s`, and without the override it would follow ~/.codex/config.toml's sandbox_mode.
 */
export function codexSendArgs(
  body: string,
  sessionId: string | null,
  model: string | null,
  json = false,
): string[] {
  return [
    "exec",
    ...(sessionId ? ["resume", sessionId] : []),
    "--skip-git-repo-check",
    ...(json ? ["--json"] : []),
    ...(model ? ["-m", model] : []),
    "-c",
    'sandbox_mode="workspace-write"',
    "--",
    body,
  ];
}

/**
 * One headless turn in *cwd*, resuming *sessionId* (a new session when null).
 * Codex takes no allow/deny list on the command line, so `unattended` adds nothing:
 * the PreToolUse gate in `.codex/hooks.json` (SW-189) applies the workspace's rules.
 * `denied` is always empty: `codex exec --json` does not report refused calls.
 */
export async function codexStartTurn(
  key: string,
  cwd: string,
  body: string,
  sessionId: string | null,
  model: string | null,
  opts: TurnOptions = {},
): Promise<TurnResult | null> {
  const args = codexSendArgs(body, sessionId, model, Boolean(opts.wait));
  const stdout = await runTurn(key, await resolveCodexBin(), args, cwd, Boolean(opts.wait));
  return stdout === null ? null : { denied: [] };
}

export function codexSignal(
  key: string,
  dir: string,
  src: { sessionFile: string | null; updatedAt: string | null } | null,
): Promise<{ signal: SessionSignal; lastActivity: string | null }> {
  return signalFrom(key, dir, src, parseCodexLines);
}

/** Reopens a session in a terminal; run from the workspace folder so the token path resolves. */
export function codexResumeCommand(
  sessionId: string | null,
  model: string | null,
  prompt?: string,
): string {
  return [
    CODEX_LAUNCH,
    // `-m` after `resume`: the subcommand reads its own options.
    ...(sessionId ? ["resume"] : []),
    ...(model ? ["-m", shellQuote(model)] : []),
    // The id comes from a session file's contents, not a checked file name.
    ...(sessionId ? [shellQuote(sessionId)] : []),
    ...(prompt ? [shellQuote(prompt)] : []),
  ].join(" ");
}
