/**
 * werkmeister logs <feature> [service]
 *
 * Tail a feature's container logs, optionally filtered to a
 * specific service. Streams output until interrupted with Ctrl+C.
 *
 * The tail — and the "is it even running" guard, so every consumer gets told
 * why a tail produced nothing — is `werkmeister-core/compose`. What is left here is
 * the banner, and the slot read that decides whether to print it: a feature
 * that is not running shows the guard's two warnings and no header, which is
 * what this command has always done.
 */

import { composeLogs } from "werkmeister-core/compose";
import { getSlot } from "werkmeister-core/slots";
import { Colors } from "../lib/config.js";
import { interruptSignal } from "../lib/interrupt.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;
  const service = (args.service as string | null) ?? null;

  if ((await getSlot(feature)) !== null) {
    console.log(
      `\n${Colors.BOLD}=== Logs: ${feature}` +
        (service ? ` / ${service}` : "") +
        ` ===${Colors.RESET}\n`,
    );
  }
  await composeLogs(feature, service, { signal: interruptSignal() });
}
