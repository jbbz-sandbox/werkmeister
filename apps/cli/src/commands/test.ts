/**
 * sandbox test <feature>
 *
 * Run Playwright tests against a feature's isolated stack. Sets the
 * SANDBOX_FEATURE environment variable so the Playwright config can
 * include the correct X-Feature cookie.
 *
 * The run itself is `sandbox-core/test_run`; what is left here is argv, the
 * cwd-dependent workspace resolution, the banner, and the exit code — a
 * failing suite is a result the library reports, not an error it throws.
 */

import { Colors, error, getSandboxRoot, resolveWorkspace, success } from "../lib/config.js";
import { interruptSignal } from "../lib/interrupt.js";
import { runFeatureTests } from "sandbox-core/test_run";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;

  console.log(`\n${Colors.BOLD}=== sandbox test: ${feature} ===${Colors.RESET}\n`);

  const result = await runFeatureTests({
    feature,
    workspace: resolveWorkspace(feature),
    root: String(getSandboxRoot()),
    extraArgs: (args.extra as string[] | null) ?? [],
    signal: interruptSignal(),
  });

  if (result.status === 0) {
    success(`All tests passed for feature '${feature}'`);
  } else {
    error(`Tests failed for feature '${feature}' (exit code ${result.status})`);
    process.exit(result.status);
  }
}
