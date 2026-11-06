/**
 * Driving a Claude Code session (SW-187: the Claude harness's session driver):
 * one headless turn per `claude-send`, the in-process turn registry, the
 * workspace list's agent signal and the terminal resume command. Callers pass
 * resolved folders; sandbox.ts maps session keys to them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runCapture, shellQuote } from "../../tool_bins.js";
import { signalFrom } from "../sessions.js";
import { runTurn } from "../turn.js";
import type { HarnessId, SessionSignal, TurnOptions, TurnResult, TurnState } from "../types.js";
import { resolveClaudeBin } from "./cli.js";
import { type ClaudeMessage, parseSessionLines } from "./transcript.js";

export type ClaudeSessionSignal = SessionSignal;
export type ClaudeTurnState = TurnState;

/** The workspace list's agent signal ({@link signalFrom}) over Claude's transcript lines. */
export function sessionSignal(
  name: string,
  dir: string,
  src: { sessionFile: string | null; updatedAt: string | null } | null,
): Promise<{ signal: ClaudeSessionSignal; lastActivity: string | null }> {
  return signalFrom(name, dir, src, parseSessionLines);
}

/**
 * `claude` argv for one headless turn. The workspace's model is passed as a flag
 * rather than left to settings.json, where a hand-set value would win.
 */
export function claudeSendArgs(
  body: string,
  sessionId: string | null,
  model: string | null,
  opts: { allow?: string[]; deny?: string[]; json?: boolean } = {},
): string[] {
  return [
    "-p",
    // Comma-joined, and followed by another flag: both are variadic and would take the body as a rule.
    ...(opts.allow?.length ? ["--allowedTools", opts.allow.join(",")] : []),
    ...(opts.deny?.length ? ["--disallowedTools", opts.deny.join(",")] : []),
    "--permission-mode",
    "acceptEdits",
    ...(opts.json ? ["--output-format", "json"] : []),
    ...(model ? ["--model", model] : []),
    ...(sessionId ? ["--resume", sessionId] : []),
    body,
  ];
}

/**
 * Run one headless turn in *cwd* via `claude -p --resume <sessionId>`,
 * continuing that session on disk, or plain `claude -p` when *sessionId* is
 * null. `--resume` finds a session only from the folder it started in, so
 * *cwd* is that folder. *name* keys the turn registry.
 *
 * FIRE-AND-FORGET unless `wait`: {@link runTurn} detaches the child after a grace
 * period; callers poll `claude-transcript` to watch the reply appear (Claude Code
 * appends messages to the session JSONL as the turn progresses).
 *
 * Headless mode can't prompt for tool permissions; `acceptEdits` lets it edit
 * files in the workspace without stalling. `unattended` also grants the
 * workspace's autonomous rules, and `wait` holds the child to its end and
 * returns what it was refused (`claude -p` exits 0 either way).
 */
export async function startTurn(
  name: string,
  cwd: string,
  body: string,
  sessionId: string | null,
  model: string | null,
  opts: TurnOptions = {},
): Promise<TurnResult | null> {
  const bin = await resolveClaudeBin();
  const root = opts.unattended;
  // Loaded here: a static import closes a cycle that reaches issue_tracker before it is initialised.
  // biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
  const rules = root && (await import("./hooks_gen.js"));
  const args = claudeSendArgs(body, sessionId, model, {
    ...(root &&
      rules && {
        allow: rules.workspaceAllowRules(root, true),
        deny: rules.workspaceDenyRules(root, true),
      }),
    json: opts.wait,
  });

  const stdout = await runTurn(name, bin, args, cwd, Boolean(opts.wait));
  return stdout === null ? null : { denied: deniedIn(stdout) };
}

/** `tool: command` for each call in a `--output-format json` result's `permission_denials`. */
export function deniedIn(stdout: string): string[] {
  let result: { permission_denials?: Array<{ tool_name?: string; tool_input?: any }> };
  try {
    result = JSON.parse(stdout);
  } catch {
    return [];
  }
  const calls = (result.permission_denials ?? []).map((d) => {
    const detail = String(d.tool_input?.command ?? "")
      .split("\n")[0]
      .slice(0, 120);
    return detail ? `${d.tool_name}: ${detail}` : String(d.tool_name);
  });
  return [...new Set(calls)];
}

/**
 * Whether a message relayed at `sentAt` ran in the target session: a user turn
 * after the send that holds its text. SendMessage succeeding and an idle notice
 * arriving prove nothing: a UserPromptSubmit hook can drop the prompt (SW-348).
 */
export function relayPickedUp(
  messages: ClaudeMessage[],
  relay: { sentAt: string; text: string },
): boolean {
  const sentAt = Date.parse(relay.sentAt);
  return messages.some(
    (m) =>
      m.role === "user" &&
      m.timestamp !== null &&
      Date.parse(m.timestamp) > sentAt &&
      m.text.includes(relay.text),
  );
}

/**
 * Whether an interactive session of *harness* (`claude` not in a `-p` turn, `codex` not in `exec`) runs with its
 * cwd inside *ws*: the hooks' record can miss an open session, and a headless resume beside it forks it (SW-397, SW-488).
 * shortcut: Desktop sessions (the app's own cwd) and hosts without `ps`/`lsof` are not seen; they rely
 * on the record. Read /proc on Linux if a host without lsof needs it.
 */
export async function claudeOpenIn(ws: string, harness: HarnessId): Promise<boolean> {
  const bin = harness === "codex" ? "codex" : "claude";
  // A `codex` with flags before `exec` counts as open: a pending nudge, never a fork.
  const headless = harness === "codex" ? /^ (exec|e)( |$)/ : /(^| )(-p|--print)( |$)/;
  const ps = await runCapture("ps", ["-axo", "pid=,args="]).catch(() => null);
  const pids = (ps?.stdout ?? "")
    .split("\n")
    .map((l) => l.trim().match(/^(\d+) (\S+)(.*)$/))
    .filter((m) => m && path.basename(m[2]) === bin && !headless.test(m[3]))
    .map((m) => m?.[1]);
  if (!pids.length) return false;
  const root = await fs.realpath(ws).catch(() => ws);
  // lsof exits 1 when a listed pid has gone; what it printed for the rest still counts.
  const cwds = await runCapture("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")]).catch(
    () => null,
  );
  return (cwds?.stdout ?? "")
    .split("\n")
    .some((l) => l.startsWith("n") && (l.slice(1) === root || l.slice(1).startsWith(`${root}/`)));
}

/** The shell command that reopens a workspace session in a terminal. */
export function claudeResumeCommand(
  sessionId: string | null,
  model: string | null,
  prompt?: string,
): string {
  return [
    "claude",
    ...(model ? ["--model", shellQuote(model)] : []),
    ...(sessionId ? ["--resume", sessionId] : []),
    ...(prompt ? [shellQuote(prompt)] : []),
  ].join(" ");
}
