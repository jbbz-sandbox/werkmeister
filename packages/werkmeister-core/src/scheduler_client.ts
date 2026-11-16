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
 * Runs one operation of the workspace scheduler (the queue of workspaces waiting for capacity).
 * Uses the daemon when it is running, otherwise runs in-process: it calls *local* when there is
 * no daemon token (a fresh home folder, CI, tests) or the daemon is down, and warns once that it
 * fell back. Whatever the daemon printed while it ran the op is printed here too.
 *
 * @param op - The scheduler operation's name, e.g. `"queue"`.
 * @param args - The operation's arguments.
 * @param local - Runs the same operation in this process; used when the daemon can't be reached.
 * @param timeoutMs - How long to wait for the daemon, in milliseconds. Defaults to 120000.
 * @returns The operation's result, from the daemon or from *local*.
 * @throws {@link SandboxError} when the daemon took the op but failed it or did not answer in
 * time. A daemon that is down is not an error: *local* runs instead.
 *
 * @example
 * ```ts
 * import { schedulerOp } from "werkmeister-core/sdk";
 *
 * const queue = await schedulerOp<string[]>("queue", {}, async () => []);
 * console.log(`${queue.length} waiting`);
 * ```
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

/**
 * Lists the workspaces waiting for capacity to start, in the order they will start (first come,
 * first served). Uses the daemon when it is running, otherwise reads the queue in-process.
 *
 * @returns Each waiting workspace's feature name, first in line first; empty when nothing waits.
 * @throws {@link SandboxError} when the daemon took the call but failed it or did not answer in
 * time.
 *
 * @example
 * ```ts
 * import { waitingQueue } from "werkmeister-core/sdk";
 *
 * const queue = await waitingQueue();
 * console.log(queue.length ? `next up: ${queue[0]}` : "nothing waiting");
 * ```
 */
export function waitingQueue(): Promise<string[]> {
  return schedulerOp("queue", {}, async () => readQueue());
}
