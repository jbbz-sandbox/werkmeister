/**
 * werkmeister internal wait-load
 *
 * The host-load wait the generated with-temp-home runs before its command
 * (SW-209, SW-224). Only with-temp-home waits: the pr gate stopped waiting in
 * SW-542, and on macOS the wait returns at once (SW-556). Exits 75 when the
 * wait is spent with load still over the limit, so the wrapper doesn't run its
 * command (SW-540).
 */

import * as os from "node:os";

import { waitForHostLoadNow } from "werkmeister-core";
import { hostLoadLimit } from "werkmeister-core/scheduler_state";

export async function run(): Promise<void> {
  const note = await waitForHostLoadNow();
  if (!note) return;
  const [load] = os.loadavg();
  const limit = hostLoadLimit(os.availableParallelism());
  if (load <= limit) {
    console.error(`with-temp-home: ${note}`);
    return;
  }
  console.error(
    `with-temp-home: host load ${load.toFixed(1)} over ${limit} after the host-load wait; not running. Retry when load falls, or pass --no-wait.`,
  );
  process.exitCode = 75;
}
