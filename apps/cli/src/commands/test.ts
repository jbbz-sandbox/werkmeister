/**
 * sandbox test <feature>
 *
 * Run Playwright tests against a feature's isolated stack. Sets the
 * SANDBOX_FEATURE environment variable so the Playwright config can
 * include the correct X-Feature cookie.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors, error, getSandboxRoot, info, resolveWorkspace, success, warn } from "../lib/config.js";
import { ProcError, run as procRun } from "../lib/proc.js";
import { getSlot } from "../lib/slots.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;

  console.log(`\n${Colors.BOLD}=== sandbox test: ${feature} ===${Colors.RESET}\n`);

  const slot = getSlot(feature);
  if (slot === null) {
    warn(`Feature '${feature}' does not have an allocated slot`);
    warn("Start it first with: sandbox up " + feature);
    warn("Running tests anyway with feature header routing...");
  }

  // Build environment: inherit current env + add sandbox vars
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["SANDBOX_FEATURE"] = feature;
  if (slot) {
    env["SANDBOX_SLOT"] = String(slot);
  }

  // Determine working directory -- prefer the feature workspace if it
  // contains a playwright config, otherwise use the sandbox root
  const workspace = resolveWorkspace(feature);
  const root = getSandboxRoot();

  // Look for playwright config in common locations
  const playwrightDirs = [workspace, root];

  let cwd = String(root);
  for (const d of playwrightDirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      let found = false;
      for (const configName of [
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mjs",
      ]) {
        if (fs.existsSync(path.join(d, configName))) {
          cwd = String(d);
          found = true;
          break;
        }
      }
      if (!found) {
        continue;
      }
      break;
    }
  }

  info(`Working directory: ${cwd}`);
  info(`SANDBOX_FEATURE=${feature}`);

  // Extra args to pass through to playwright
  const extraArgs = (args.extra as string[] | null) ?? [];

  const cmd = ["npx", "playwright", "test", ...extraArgs];
  info(`Running: ${cmd.join(" ")}`);
  console.log();

  let result;
  try {
    result = procRun(cmd, { env, cwd, timeout: 600, stdio: "inherit" });
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") {
      error(
        "npx not found. Ensure Node.js is installed and npx is on your PATH.\n" +
          "       You may also need to run: npm install -D @playwright/test",
      );
      process.exit(1);
    }
    if (e instanceof ProcError && e.code === "ETIMEDOUT") {
      error("Playwright tests timed out after 10 minutes");
      process.exit(1);
    }
    throw e;
  }
  console.log();
  if (result.status === 0) {
    success(`All tests passed for feature '${feature}'`);
  } else {
    error(`Tests failed for feature '${feature}' (exit code ${result.status})`);
    process.exit(result.status);
  }
}
