/**
 * sandbox stop <feature>
 *
 * Stop containers for a feature without removing them or releasing the slot.
 * The feature can be resumed with ``sandbox restart <feature>`` or
 * ``sandbox up <feature>``.
 *
 * For shared infrastructure use ``sandbox stop infra``.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors, error, info } from "../lib/config.js";
import { composeStop } from "../lib/docker.js";
import { stop as infraStop } from "../lib/infra.js";
import { getSlot } from "../lib/slots.js";

function loadDotenv(start: string): Record<string, string> {
  let dir = start;
  while (true) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile) && fs.statSync(envFile).isFile()) {
      const result: Record<string, string> = {};
      for (let line of fs.readFileSync(envFile, "utf8").split("\n")) {
        line = line.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) {
          continue;
        }
        const i = line.indexOf("=");
        result[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return result;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  if (feature === "infra") {
    await infraStop();
    return;
  }

  console.log(`\n${Colors.BOLD}=== sandbox stop: ${feature} ===${Colors.RESET}\n`);

  const slot = getSlot(feature);
  if (slot === null) {
    error(`Feature '${feature}' is not running (no slot allocated)`);
    info(`Start it with: sandbox up ${feature}`);
    process.exit(1);
  }

  info(`Stopping containers for '${feature}' (slot ${slot})...`);
  const ok = composeStop(feature);

  if (ok) {
    console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' stopped${Colors.RESET}\n`);
    console.log(
      `  ${Colors.DIM}Slot ${slot} preserved — resume with: sandbox restart ${feature}${Colors.RESET}`,
    );
    console.log(
      `  ${Colors.DIM}To fully tear down:              sandbox down ${feature}${Colors.RESET}`,
    );
    console.log();
  } else {
    error(`Failed to stop containers for '${feature}'`);
    process.exit(1);
  }
}
