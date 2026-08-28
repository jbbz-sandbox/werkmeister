/**
 * Shared infrastructure management (compose/shared-infra.yml).
 *
 * Used by sandbox down/stop/restart when the target is "infra". Bringing infra
 * *up* is `sandbox connect`, which is a command: `up.ts` calls it directly
 * rather than routing through here, because a library reaching back into
 * `apps/cli/src/commands` is the inversion this package exists to undo.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors } from "./colors.js";
import { infraRoot, sandboxRoot } from "./config.js";
import { ProcError, run } from "./proc.js";
import { error, info, raw, success } from "./reporter.js";
import { restartAll, stopAll } from "./web_servers.js";

function composeCmd(subcommand: string[]): boolean {
  const root = sandboxRoot();
  const composeFile = path.join(infraRoot(), "compose", "shared-infra.yml");
  // --env-file only if a root .env exists — shared-infra.yml interpolates only
  // ${HOME} (from the process env), so the file is optional. Passing a missing
  // path makes `docker compose` hard-error. `connect`'s startSharedInfra has
  // guarded this since it was written; this side never did, so every teardown
  // hard-errored on a machine with no apps/cli/.env — which is all of them,
  // since nothing creates that file.
  const envFile = path.join(root, ".env");
  const envArgs = fs.existsSync(envFile) ? ["--env-file", envFile] : [];
  const cmd = ["docker", "compose", ...envArgs, "-f", composeFile, ...subcommand];
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
