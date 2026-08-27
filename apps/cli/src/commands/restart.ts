/**
 * sandbox restart <feature>
 *
 * Restart all containers for a feature's stack.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors, error, info } from "../lib/config.js";
import { composeRestart } from "../lib/docker.js";
import { restart as infraRestart } from "sandbox-core/infra";
import { getSlot } from "sandbox-core/slots";

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
    await infraRestart();
    return;
  }

  console.log(`\n${Colors.BOLD}=== sandbox restart: ${feature} ===${Colors.RESET}\n`);

  const slot = await getSlot(feature);
  if (slot === null) {
    error(`Feature '${feature}' is not running (no slot allocated)`);
    info(`Start it with: sandbox up ${feature}`);
    process.exit(1);
  }

  info(`Restarting containers for '${feature}' (slot ${slot})...`);
  const ok = composeRestart(feature);

  if (ok) {
    console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' restarted${Colors.RESET}\n`);
  } else {
    error(`Failed to restart containers for '${feature}'`);
    info("Check with: sandbox logs " + feature);
    process.exit(1);
  }
}
