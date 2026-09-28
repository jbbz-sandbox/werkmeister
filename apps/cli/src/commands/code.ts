/**
 * sandbox code [feature]
 *
 * Open a workspace in VS Code. The lookup and launch are `sandbox-core`'s
 * `openWorkspace` -- the same call the dashboard's `open-workspace` tool makes.
 */

import { Colors, error } from "../lib/config.js";
import { openWorkspace } from "sandbox-core";
import { loadDotenv } from "../lib/dotenv.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const name = (args.feature as string | null) || loadDotenv(process.cwd())["FEATURE"];
  if (!name) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  const { path } = await openWorkspace(name);
  console.log(`${Colors.GREEN}Opened '${name}' in VS Code${Colors.RESET}  ${Colors.DIM}${path}${Colors.RESET}`);
}
