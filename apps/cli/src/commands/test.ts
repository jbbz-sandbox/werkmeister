/**
 * werkmeister feature test <feature> [--scaffold]
 *
 * Run a feature's Playwright suite, if the workspace has one. Sets the
 * SANDBOX_FEATURE environment variable so the Playwright config can
 * include the correct X-Feature cookie.
 *
 * `--scaffold` instead writes a starter suite into the workspace and installs
 * the pinned Playwright, without running anything (the feature-test skill).
 *
 * The run itself is `werkmeister-core/test_run`; what is left here is argv, the
 * cwd-dependent workspace resolution, the banner, and the exit code — a
 * failing suite is a result the library reports, not an error it throws.
 */

import * as fs from "node:fs";
import { getSlot } from "werkmeister-core/slots";
import {
  ensurePlaywright,
  featureIngress,
  runFeatureTests,
  scaffoldFeatureTests,
} from "werkmeister-core/test_run";
import { Colors, error, info, resolveWorkspace, success } from "../lib/config.js";
import { interruptSignal } from "../lib/interrupt.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;

  if (args.scaffold) {
    await scaffold(feature, args.workspace as string | null, args.base_url as string | null);
    return;
  }

  console.log(`\n${Colors.BOLD}=== werkmeister test: ${feature} ===${Colors.RESET}\n`);

  const result = await runFeatureTests({
    feature,
    workspace: resolveWorkspace(feature),
    extraArgs: (args.extra as string[] | null) ?? [],
    signal: interruptSignal(),
  });

  if (result.message) {
    error(result.message);
    process.exit(result.status);
  }
  if (result.status === 0) {
    success(`All tests passed for feature '${feature}'`);
  } else {
    error(`Tests failed for feature '${feature}' (exit code ${result.status})`);
    process.exit(result.status);
  }
}

async function scaffold(feature: string, workspaceOverride: string | null, baseUrl: string | null) {
  const ingress = featureIngress(baseUrl);
  // A running feature already owns this name; a new suite for it would test someone else's stack.
  if ((await getSlot(feature)) !== null) {
    error(`Feature '${feature}' is already allocated`);
    error(`Choose a different name, or run: werkmeister feature down ${feature}`);
    process.exit(1);
  }
  const workspace = resolveWorkspace(feature, workspaceOverride);
  if (!fs.existsSync(workspace)) {
    error(`Workspace directory does not exist: ${workspace}`);
    process.exit(1);
  }
  info(`workspace: ${workspace}`);
  info(`base URL:  ${ingress.baseUrl}`);
  const created = scaffoldFeatureTests(feature, workspace, ingress);
  for (const p of created) success(`created ${p}`);
  if (!created.length) info("playwright.config.ts and the spec already exist — skipping");
  ensurePlaywright(workspace);
  // Last line, for the skill to capture.
  console.log(`WORKSPACE_PATH=${workspace}`);
}
