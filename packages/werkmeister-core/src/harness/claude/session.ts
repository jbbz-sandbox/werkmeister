/**
 * Driving a Claude Code session (SW-187: the Claude harness's session driver):
 * one headless turn per `claude-send`, the in-process turn registry, the
 * workspace list's agent signal and the terminal resume command. Callers pass
 * resolved folders; sandbox.ts maps session keys to them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { type AgentState, asksQuestion, questionOf, readAgentState } from "../../agent_state.js";
import { runCapture, shellQuote } from "../../tool_bins.js";
import { runTurn, turnStatus } from "../turn.js";
import type { SessionSignal, TurnOptions, TurnResult, TurnState } from "../types.js";
import { resolveClaudeBin } from "./cli.js";
import { type ClaudeMessage, parseSessionLines } from "./transcript.js";

export type ClaudeSessionSignal = SessionSignal;
export type ClaudeTurnState = TurnState;

/** Past this, a turn whose transcript ends mid-turn has died rather than gone quiet on a long tool call. */
const LIVE_TURN_MS = 10 * 60 * 1000;

/** Read the last `maxBytes` of a file, dropping a leading partial line. Cheap enough
 *  to run per-workspace in the status sweep without reading whole transcripts. */
async function readFileTail(file: string, maxBytes = 131072): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}

/**
 * The workspace list's agent signal. A live claude-send turn this process runs
 * is working; otherwise the state file the workspace's hooks write (agent_state.ts)
 * says what the session last did. A workspace whose hooks predate it falls back
 * to the transcript tail: Claude spoke last → needs-you if it asked, else done;
 * a fresh tool row or user message → working; anything else → idle. The tail
 * can't see a permission prompt; only the Notification hook can.
 */
export async function sessionSignal(
  name: string,
  dir: string,
  src: { sessionFile: string | null; updatedAt: string | null } | null,
): Promise<{ signal: ClaudeSessionSignal; lastActivity: string | null }> {
  const lastActivity = src?.updatedAt ?? null;
  const state = turnStatus(name).state;
  const signal = (agent: AgentState, at = lastActivity, question: string | null = null) => ({
    signal: { state, agent, at, question },
    lastActivity,
  });
  if (state === "running") return signal("working");
  const recorded = readAgentState(dir);
  if (recorded) return signal(recorded.state, recorded.at, recorded.question ?? null);
  let last: ClaudeMessage | undefined;
  try {
    if (src?.sessionFile) last = parseSessionLines(await readFileTail(src.sessionFile)).at(-1);
  } catch {
    /* best-effort — no signal */
  }
  if (!last || !lastActivity) return signal("idle");
  if (last.role === "assistant")
    return asksQuestion(last.text)
      ? signal("needs-you", lastActivity, questionOf(last.text))
      : signal("done");
  return signal(Date.now() - Date.parse(lastActivity) < LIVE_TURN_MS ? "working" : "idle");
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
 * Whether an interactive `claude` (not a `-p` turn) runs with its cwd inside *ws*: the hooks'
 * record can miss an open session, and a headless `--resume` beside it forks the transcript (SW-397).
 * shortcut: Desktop sessions (the app's own cwd) and hosts without `ps`/`lsof` are not seen; they rely
 * on the record. Read /proc on Linux if a host without lsof needs it.
 */
export async function claudeOpenIn(ws: string): Promise<boolean> {
  const ps = await runCapture("ps", ["-axo", "pid=,args="]).catch(() => null);
  const pids = (ps?.stdout ?? "")
    .split("\n")
    .map((l) => l.trim().match(/^(\d+) (\S+)(.*)$/))
    .filter((m) => m && path.basename(m[2]) === "claude" && !/(^| )(-p|--print)( |$)/.test(m[3]))
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
