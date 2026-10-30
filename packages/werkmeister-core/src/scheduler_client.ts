/**
 * The host daemon owns the scheduler (SW-185): slot leases, the waiting queue
 * and starting waiters. The daemon runs each op in its own process; every
 * other process (the CLI, the stdio MCP server, the dashboard) asks it over
 * `POST /api/tool`. The store stays the files in `scheduler_state.ts` under
 * their locks, so with no daemon a client runs the op itself and nothing
 * drifts (SW-185 decision D1: the file path stays as the fallback).
 */

import { callTool, DaemonUnavailable, daemonToken } from "./daemon_client.js";
import { raw, warn } from "./reporter.js";
import { readQueue } from "./scheduler_state.js";

let owner = false;
let warned = false;

/** The daemon calls this at start: from then on this process runs every op itself. */
export function ownScheduler(): void {
  owner = true;
}

/**
 * Run scheduler *op* in the daemon, or *local* here when this process is the
 * daemon, has no token to reach one (a fresh HOME, CI, tests), or finds it down.
 * The daemon's transcript is relayed so the caller prints what it did.
 */
export async function schedulerOp<T>(
  op: string,
  args: Record<string, unknown>,
  local: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (owner || !daemonToken()) return local();
  try {
    const { data, text } = await callTool<{ value: T }>(
      "scheduler",
      { op, ...args },
      { timeoutMs },
    );
    if (text) raw(text);
    return data.value;
  } catch (e) {
    if (!(e instanceof DaemonUnavailable)) throw e;
    if (!warned) warn(`${e.message} Scheduling in this process instead.`);
    warned = true;
    return local();
  }
}

/** The features waiting for capacity, first come first served. */
export function waitingQueue(): Promise<string[]> {
  return schedulerOp("queue", {}, async () => readQueue());
}
