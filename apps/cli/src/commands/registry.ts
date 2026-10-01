/**
 * sandbox registry [sync] [--check]
 *
 * Regenerate ~/.sandbox/services.yaml from every <repo>/.sandbox/services.yaml
 * under paths.repos_root, merged under ~/.sandbox/services.local.yaml. The
 * same step `sandbox setup` runs, on its own: for the moment you clone a new
 * repo and want it registered without a full setup pass.
 *
 *   sandbox registry            # regenerate (sync is the default action)
 *   sandbox registry --check    # report drift; nonzero exit when stale
 */

import { Colors, success, warn } from "../lib/config.js";
import { syncRegistry } from "sandbox-core/registry_sync";

export async function run(args: Record<string, unknown>): Promise<void> {
  const action = String(args.action ?? "sync");
  if (action !== "sync") {
    warn(`Unknown action \`${action}\` — the only action is \`sync\` (the default).`);
    process.exit(2);
  }
  const check = Boolean(args.check);
  const steps = syncRegistry({ checkOnly: check });
  for (const step of steps) {
    const mark = step.ok ? `${Colors.GREEN}✓${Colors.RESET}` : `${Colors.RED}✗${Colors.RESET}`;
    console.log(`${mark} ${step.label}: ${step.detail}`);
  }
  if (steps.some((s) => !s.ok)) {
    warn(check ? "Registry is stale — run `sandbox registry sync`." : "Registry was not generated.");
    process.exit(1);
  }
  success(check ? "Registry is up to date." : "Registry generated.");
}
