/**
 * werkmeister feature resume <feature>
 *
 * Bring back exactly the containers `werkmeister feature pause` froze, release the Claude
 * session, and tell it to continue if Pause cut a turn (SW-70).
 */

import * as path from "node:path";

import { resumeAndNudge } from "werkmeister-core";
import { workspaceForFeature } from "werkmeister-core/compose";
import { Colors, error } from "../lib/config.js";
import { featureArg, reportHint } from "./pause.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = featureArg(args, "Resuming");
  const ws = workspaceForFeature(feature);
  if (!ws) {
    error(`No workspace folder for '${feature}'. Run it from the workspace folder.`);
    process.exit(1);
  }
  console.log(`\n${Colors.BOLD}=== werkmeister resume: ${feature} ===${Colors.RESET}\n`);
  try {
    const { containers } = await resumeAndNudge(path.basename(ws), ws, feature);
    for (const c of containers) console.log(`  ${c.name}: ${c.did}`);
    console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' resumed${Colors.RESET}\n`);
  } catch (e) {
    reportHint(e, {
      NOT_PAUSED: `Nothing to resume. Check with: werkmeister feature status`,
      COMPOSE_RESUME_FAILED: `Check with: werkmeister feature logs ${feature}`,
    });
  }
}
