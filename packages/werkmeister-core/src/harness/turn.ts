/**
 * The detached-turn runner every harness shares (SW-383): a headless turn outlives
 * the caller's MCP request timeout on any harness, so the detach, grace period and
 * in-process turn registry live here and an adapter supplies only argv and how to
 * read the child's output.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { WorkspaceError } from "../errors.js";
import { childEnv, stripAnsi } from "../tool_bins.js";
import type { TurnState, TurnStatus } from "./types.js";

/** In-process registry of the most recent turn per session key. */
const turns = new Map<string, TurnState>();

/**
 * Turn-transition bus: emits `(sessionKey, {state, error})` whenever a turn flips
 * running/done/failed. The live tailer (lib/session-stream.ts) subscribes so the
 * browser typing indicator ends the instant the child exits, without polling
 * turn status. Event name is the session key; one listener per active tailer,
 * so raise the cap.
 */
export const turnEvents = new EventEmitter();
turnEvents.setMaxListeners(0);

/** The most recent turn for *key*; "idle" when this process started none (callers then poll the transcript). */
export function turnStatus(key: string): TurnStatus {
  const turn = turns.get(key);
  if (!turn) return { state: "idle", startedAt: null, exitCode: null, error: null };
  return {
    state: turn.state,
    startedAt: turn.startedAt,
    exitCode: turn.exitCode,
    error: turn.error,
  };
}

/**
 * Spawn one detached turn of *bin* in *cwd* and register it under *key*.
 *
 * FIRE-AND-FORGET: agentic turns routinely exceed the caller's MCP request
 * timeout (~60s), so this does NOT wait for the reply. The child is held for a
 * short grace period to surface immediate failures (missing CLI, bad session),
 * then detached and null is returned; callers watch the transcript. With *wait*
 * the child is held to its end and its stdout returned. Throws a WorkspaceError
 * when the child fails to start or, with *wait*, exits non-zero.
 */
export async function runTurn(
  key: string,
  bin: string,
  args: string[],
  cwd: string,
  wait: boolean,
): Promise<string | null> {
  const child = spawn(bin, args, {
    cwd,
    env: childEnv(),
    detached: true,
    stdio: ["ignore", wait ? "pipe" : "ignore", "pipe"],
  });
  let stdout = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });

  // Registered so turnStatus can report exactly when it finishes, instead of
  // guessing from transcript quiescence.
  const turn: TurnState = {
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    state: "running",
    exitCode: null,
    error: null,
  };
  turns.set(key, turn);
  turnEvents.emit(key, { state: "running", error: null });

  let stderr = "";
  child.stderr?.on("data", (d) => {
    if (stderr.length < 8192) stderr += d.toString();
  });
  child.on("error", (e) => {
    turn.state = "failed";
    turn.error = e.message;
    turnEvents.emit(key, { state: "failed", error: turn.error });
  });
  child.on("exit", (code) => {
    turn.exitCode = code;
    if (code === 0) {
      turn.state = "done";
    } else {
      turn.state = "failed";
      const detail = stripAnsi(stderr).trim().split("\n").slice(-2).join(" ");
      turn.error = `${path.basename(bin)} exited with code ${code}${detail ? `: ${detail}` : ""}`;
    }
    turnEvents.emit(key, { state: turn.state, error: turn.error });
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
  if (!wait) {
    child.unref();
    return null;
  }
  await exited;
  if (turn.error) throw new WorkspaceError(`The turn failed — ${turn.error}`);
  return stdout;
}
