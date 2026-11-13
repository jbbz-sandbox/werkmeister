/**
 * werkmeister internal wait-load
 *
 * The host-load and free-memory wait the generated with-temp-home runs before
 * its command (SW-209, SW-224, SW-620). Only with-temp-home waits: the pr gate
 * stopped waiting in SW-542, and on macOS only memory counts (SW-556). Exits 75
 * when the wait is spent with load or memory still over its limit, so the
 * wrapper doesn't run its command (SW-540).
 */

import { waitForHostLoadNow } from "werkmeister-core";

export async function run(): Promise<void> {
  const note = await waitForHostLoadNow();
  if (!note.startsWith("ran with")) {
    if (note) console.error(`with-temp-home: ${note}`);
    return;
  }
  console.error(
    `with-temp-home: ${note.slice("ran with ".length).split(";")[0]} after the wait; not running. Retry when load falls or memory frees, or pass --no-wait.`,
  );
  process.exitCode = 75;
}
