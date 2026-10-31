/**
 * werkmeister internal wait-load
 *
 * The pr gate's host-load wait (SW-209), run by the generated with-temp-home
 * before its command (SW-224). Always exits 0: load never decides whether the
 * command runs.
 */

import { waitForHostLoadNow } from "werkmeister-core";

export async function run(): Promise<void> {
  const note = await waitForHostLoadNow();
  if (note) console.error(`with-temp-home: ${note}`);
}
