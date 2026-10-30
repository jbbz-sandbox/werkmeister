/**
 * Cross-process file locking for werkmeister.
 *
 * Provides a simple advisory lock to prevent race conditions when multiple
 * `werkmeister up` / `werkmeister down` commands run concurrently.  All lock files
 * live under `~/.werkmeister/locks/`.
 *
 * Usage:
 *
 *     import { sandboxLock } from "./locks.js";
 *
 *     await sandboxLock("slots", () => {
 *       const data = readSlots();
 *       // ... mutate ...
 *       writeSlots(data);
 *     });
 *
 * The lock is automatically released when the callback returns (even on
 * exceptions; async callbacks release when the returned promise settles).
 * The wait between retries awaits a timer, so a holder in the same process
 * that is suspended at an await can still run and release (SW-183).
 *
 * ponytail: Node has no fcntl.flock, so this uses an O_EXCL PID-stamped lock
 * file instead. Unlike flock, a crashed holder leaves the file behind — we
 * compensate by probing the recorded PID and stealing locks whose holder is
 * dead. Swap in a real flock binding only if the PID probe ever proves
 * insufficient.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { dotDir } from "./config.js";

const lockDir = () => path.join(dotDir(os.homedir()), "locks");

// Poll interval (seconds) for the retry loop.
const _RETRY_INTERVAL = 0.1;

/** True when the PID recorded in the lock file no longer belongs to a live process. */
function holderIsDead(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false; // vanished or unreadable — let the acquire loop retry
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return true; // corrupt lock file: no live holder can own it
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Try to create the lock file exclusively; returns true on success. */
function tryAcquire(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (holderIsDead(lockPath)) {
        // Steal a stale lock. ponytail: read-then-unlink has a narrow race
        // against another stealer; both then re-enter tryAcquire and only
        // one wins, which is good enough for a dev CLI.
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* someone else stole it first */
        }
      }
      return false;
    }
    throw err;
  }
}

/**
 * Acquire an exclusive advisory lock named *name* around *fn*.
 *
 * Parameters
 * ----------
 * name
 *     Logical lock name (e.g. `"slots"`, `"caddyfile"`).  Maps to
 *     `~/.werkmeister/locks/<name>.lock`.
 * fn
 *     The critical section. Its return value is passed through. If it
 *     returns a promise, the lock is held until the promise settles.
 * timeout
 *     `undefined` (default) waits forever until the lock is acquired —
 *     identical to historical behavior, safe for all existing callers.
 *     A finite value (seconds) retries until it elapses, then rejects
 *     instead of hanging forever. This lets a caller recover from a
 *     crashed lock holder without requiring manual deletion of the lock
 *     file.
 */
export async function sandboxLock<T>(
  name: string,
  fn: () => T | Promise<T>,
  { timeout }: { timeout?: number } = {},
): Promise<T> {
  const dir = lockDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${name}.lock`);

  const deadline = timeout !== undefined ? performance.now() + timeout * 1000 : null;
  while (!tryAcquire(lockPath)) {
    if (deadline !== null && performance.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeout}s waiting for lock ` +
          `'${name}' (${lockPath}). The previous holder may ` +
          "have crashed without releasing it; if no werkmeister " +
          "process is running, it is safe to delete this " +
          "file and retry.",
      );
    }
    await sleep(_RETRY_INTERVAL * 1000);
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}
