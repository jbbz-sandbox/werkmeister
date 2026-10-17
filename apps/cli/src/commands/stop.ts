/**
 * sandbox stop <feature>
 *
 * Stop containers for a feature without removing them or releasing the slot.
 * The feature can be resumed with ``sandbox restart <feature>`` or
 * ``sandbox up <feature>``.
 *
 * For shared infrastructure use ``sandbox stop infra``.
 *
 * ``sandbox stop --if-idle`` is the SessionEnd hook behind ``auto_stop`` (#231).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SandboxError } from "sandbox-core/errors";
import { stop as infraStop } from "sandbox-core/infra";
import { idleStopFeature, stop as stopFeature } from "sandbox-core/lifecycle";
import { Colors, error, info } from "../lib/config.js";
import { findDotenv, loadDotenv } from "../lib/dotenv.js";

/**
 * Stop the workspace's own feature unless another Claude session is open in it.
 * A SessionEnd hook must never hold up or break exit, so this prints nothing,
 * never throws, and hands `sandbox stop <feature>` to a detached child instead of
 * waiting on `docker compose stop`.
 */
function stopIfIdle(): void {
  try {
    const raw = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    const hook = raw.trim() ? JSON.parse(raw) : {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const start = process.env.CLAUDE_PROJECT_DIR || str(hook?.cwd) || process.cwd();
    const envFile = findDotenv(start);
    if (!envFile) return;
    const workspaceRoot = path.dirname(envFile);
    const feature = idleStopFeature({
      feature: loadDotenv(workspaceRoot)["FEATURE"],
      workspaceRoot,
      sessionId: str(hook?.session_id),
      reason: str(hook?.reason),
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    });
    if (!feature) return;
    spawn(process.execPath, [process.argv[1], "stop", feature], {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // nothing here may surface at session exit
  }
}

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.if_idle) {
    stopIfIdle();
    return;
  }
  const dotenv = loadDotenv(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  console.log(`\n${Colors.BOLD}=== sandbox stop: ${feature} ===${Colors.RESET}\n`);

  if (feature === "infra") {
    await infraStop();
    console.log();
    return;
  }

  let slot: number;
  try {
    ({ slot } = await stopFeature(feature));
  } catch (e) {
    // Reported here rather than by main.ts's handler because the hint has to
    // land *between* the error line and the exit, and the handler only knows
    // how to print the message. Every other code propagates.
    if (e instanceof SandboxError && e.code === "NOT_RUNNING") {
      error(e.message);
      info(`Start it with: sandbox up ${feature}`);
      process.exit(1);
    }
    throw e;
  }

  console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' stopped${Colors.RESET}\n`);
  console.log(
    `  ${Colors.DIM}Slot ${slot} preserved — resume with: sandbox restart ${feature}${Colors.RESET}`,
  );
  console.log(
    `  ${Colors.DIM}To fully tear down:              sandbox down ${feature}${Colors.RESET}`,
  );
  console.log();
}
