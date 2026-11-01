/**
 * Driving a Claude Code session (SW-187: the Claude harness's session driver):
 * one headless turn per `claude-send`, the in-process turn registry, the
 * workspace list's agent signal and the terminal resume command. Callers pass
 * resolved folders; sandbox.ts maps session keys to them.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { type AgentState, asksQuestion, questionOf, readAgentState } from "../../agent_state.js";
import { WorkspaceError } from "../../errors.js";
import { childEnv, shellQuote, stripAnsi } from "../../tool_bins.js";
import { resolveClaudeBin } from "./cli.js";
import { type ClaudeMessage, parseSessionLines } from "./transcript.js";

export interface ClaudeSessionSignal {
  /** Most recent claude-send turn state this server tracked (idle = none / after restart). */
  state: "running" | "done" | "failed" | "idle";
  /** Working, needs you (a question or permission prompt), done or idle (SW-46). */
  agent: AgentState;
  /** When `agent` began, or the transcript's mtime when it is inferred from the tail; null with no session. */
  at: string | null;
  /** What `needs-you` is waiting on, when known. */
  question: string | null;
}

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
  const state: ClaudeSessionSignal["state"] = claudeTurns.get(name)?.state ?? "idle";
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
): string[] {
  return [
    "-p",
    "--permission-mode",
    "acceptEdits",
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
 * FIRE-AND-FORGET: agentic turns routinely exceed the caller's MCP request
 * timeout (~60s), so this does NOT wait for the reply. The child is held for a
 * short grace period to surface immediate failures (missing CLI, bad session),
 * then detached; callers poll `claude-transcript` to watch the reply appear
 * (Claude Code appends messages to the session JSONL as the turn progresses).
 *
 * Headless mode can't prompt for tool permissions; `acceptEdits` lets it edit
 * files in the workspace without stalling.
 */
export async function startTurn(
  name: string,
  cwd: string,
  body: string,
  sessionId: string | null,
  model: string | null,
): Promise<void> {
  const bin = await resolveClaudeBin();
  const args = claudeSendArgs(body, sessionId, model);

  const child = spawn(bin, args, {
    cwd,
    env: childEnv(),
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Register the turn so `claude-turn-status` can report exactly when it
  // finishes (vibe-kanban-style process tracking, instead of guessing from
  // transcript quiescence).
  const turn: ClaudeTurnState = {
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    state: "running",
    exitCode: null,
    error: null,
  };
  claudeTurns.set(name, turn);
  turnEvents.emit(name, { state: "running", error: null });

  let stderr = "";
  child.stderr?.on("data", (d) => {
    if (stderr.length < 8192) stderr += d.toString();
  });
  child.on("error", (e) => {
    turn.state = "failed";
    turn.error = e.message;
    turnEvents.emit(name, { state: "failed", error: turn.error });
  });
  child.on("exit", (code) => {
    turn.exitCode = code;
    if (code === 0) {
      turn.state = "done";
    } else {
      turn.state = "failed";
      const detail = stripAnsi(stderr).trim().split("\n").slice(-2).join(" ");
      turn.error = `claude exited with code ${code}${detail ? `: ${detail}` : ""}`;
    }
    turnEvents.emit(name, { state: turn.state, error: turn.error });
  });

  // Grace period: catch spawn errors / immediate non-zero exits, then detach.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2500);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", settle);
    child.on("exit", settle);
  });
  if (turn.state === "failed") {
    throw new WorkspaceError(`Could not start the turn — ${turn.error}`);
  }
  child.unref();
}

export interface ClaudeTurnState {
  pid: number | null;
  startedAt: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  error: string | null;
}

/** In-process registry of the most recent claude-send turn per workspace. */
const claudeTurns = new Map<string, ClaudeTurnState>();

/**
 * Turn-transition bus: emits `(workspaceName, {state, error})` whenever a
 * claude-send turn flips running/done/failed. The live tailer
 * (lib/session-stream.ts) subscribes so the browser typing indicator ends the
 * instant the child exits, without polling `claude-turn-status`. Event name is
 * the workspace name; one listener per active tailer, so raise the cap.
 */
export const turnEvents = new EventEmitter();
turnEvents.setMaxListeners(0);

/**
 * Report the state of the most recent `claude-send` turn for a workspace.
 * "idle" means no turn has been started by this server process (including
 * after a server restart — callers should fall back to transcript polling).
 */
export function turnStatus(name: string): {
  state: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
} {
  const turn = claudeTurns.get(name);
  if (!turn) return { state: "idle", startedAt: null, exitCode: null, error: null };
  return {
    state: turn.state,
    startedAt: turn.startedAt,
    exitCode: turn.exitCode,
    error: turn.error,
  };
}

/** The shell command that reopens a workspace session in a terminal. */
export function claudeResumeCommand(sessionId: string | null, model: string | null): string {
  return [
    "claude",
    ...(model ? ["--model", shellQuote(model)] : []),
    ...(sessionId ? ["--resume", sessionId] : []),
  ].join(" ");
}
