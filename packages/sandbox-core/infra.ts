/**
 * Shared infrastructure management (compose/shared-infra.yml).
 *
 * Used by sandbox up/down/stop/restart when the target is "infra".
 */

import * as path from "node:path";

import { Colors } from "./colors.js";
import { infraRoot, sandboxRoot } from "./config.js";
import { ProcError, run } from "./proc.js";
import { error, info, raw, success } from "./reporter.js";
import { restartAll, stopAll } from "./web_servers.js";

// `connect` is a CLI command, not a library module, so this stays a hoisted
// string the compiler can't resolve — and is therefore unchecked. It is broken
// today: after step 3 moved this file the path resolves against
// `sandbox-core/dist/`, where no `commands/` exists. `up()` is the last caller;
// the seam gets fixed when `connect` becomes a library function (step 5).
const CONNECT_MODULE = "../commands/connect.js";

function composeCmd(subcommand: string[]): boolean {
  const root = sandboxRoot();
  const composeFile = path.join(infraRoot(), "compose", "shared-infra.yml");
  const envFile = path.join(root, ".env");
  const cmd = ["docker", "compose", "--env-file", envFile, "-f", composeFile, ...subcommand];
  info(`Running: ${cmd.join(" ")}`);
  try {
    const result = run(cmd, { capture: true, timeout: 120 });
    if (result.status !== 0) {
      error(`docker compose failed:\n${result.stderr.trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof ProcError && err.code === "ENOENT") {
      error("docker not found");
      return false;
    }
    if (err instanceof ProcError && err.code === "ETIMEDOUT") {
      error("docker compose timed out");
      return false;
    }
    throw err;
  }
}

/** Start shared infrastructure (delegates to sandbox connect logic). */
export async function up(): Promise<void> {
  const connect = await import(CONNECT_MODULE);
  await connect.run({});
}

/** Stop and remove shared infrastructure containers. */
export async function down(volumes = false): Promise<void> {
  raw(`\n${Colors.BOLD}=== sandbox down: infra ===${Colors.RESET}\n\n`);
  await stopAll();
  const args = ["down"];
  if (volumes) {
    args.push("--volumes");
  }
  if (composeCmd(args)) {
    let msg = "Shared infrastructure stopped";
    if (volumes) {
      msg += " (volumes removed)";
    }
    success(msg);
  }
  raw("\n");
}

/** Stop shared infrastructure containers without removing them. */
export async function stop(): Promise<void> {
  raw(`\n${Colors.BOLD}=== sandbox stop: infra ===${Colors.RESET}\n\n`);
  await stopAll();
  if (composeCmd(["stop"])) {
    success("Shared infrastructure stopped (containers preserved, resumable with 'sandbox up infra')");
  }
  raw("\n");
}

/** Restart shared infrastructure containers. */
export async function restart(): Promise<void> {
  raw(`\n${Colors.BOLD}=== sandbox restart: infra ===${Colors.RESET}\n\n`);
  if (composeCmd(["restart"])) {
    success("Shared infrastructure restarted");
  }
  await restartAll();
  raw("\n");
}
