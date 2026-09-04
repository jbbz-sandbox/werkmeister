/**
 * sandbox detect [feature]
 *
 * Analyze git worktrees in the feature's workspace and report which
 * services would run locally based on changed files.
 */

import { Colors, warn } from "../lib/config.js";
import { detectReport, type DetectedService } from "sandbox-core/detect";

function printResults(detected: DetectedService[], nonLocal: string[]): void {
  console.log();
  if (detected.length) {
    console.log(
      `  ${Colors.GREEN}${Colors.BOLD}Detected ${detected.length} service(s) with changes:${Colors.RESET}`,
    );
    for (const svc of detected) {
      console.log(
        `    ${Colors.GREEN}*${Colors.RESET} ${svc.service}  (${svc.repo}, type=${svc.type})`,
      );
    }
  } else {
    console.log(`  ${Colors.YELLOW}No services detected with changes.${Colors.RESET}`);
    console.log(`  ${Colors.DIM}This means all services would come from k8s.${Colors.RESET}`);
    console.log(
      `  ${Colors.DIM}Use 'sandbox up <feature> -s <service>' to force a service to run locally.${Colors.RESET}`,
    );
  }

  if (nonLocal.length) {
    console.log(`\n  ${Colors.DIM}k8s (unchanged): ${nonLocal.join(", ")}${Colors.RESET}`);
  }
  console.log();
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const workspaceOverride = (args.workspace as string | null) ?? null;
  const feature = (args.feature as string | null) ?? "";

  const label = feature ? `: ${feature}` : "";
  console.log(`\n${Colors.BOLD}=== sandbox detect${label} ===${Colors.RESET}\n`);

  // The two "nothing to do" cases come back as fields rather than as throws,
  // because each prints its own hint and neither is a failure exit.
  const report = detectReport(feature, workspaceOverride);

  if (!report.workspaceExists) {
    warn(`Workspace not found: ${report.workspace}`);
    console.log(`\n  ${Colors.DIM}Expected workspace at: ${report.workspace}${Colors.RESET}`);
    if (!workspaceOverride) {
      console.log(
        `  ${Colors.DIM}Create worktrees there, use --workspace to point to your repos, or check the feature name.${Colors.RESET}`,
      );
    }
    console.log();
    return;
  }

  if (!report.serviceCount) {
    warn("No services configured in config/services.yaml");
    console.log(`  ${Colors.DIM}Create config/services.yaml with service definitions.${Colors.RESET}`);
    console.log();
    return;
  }

  printResults(report.detected, report.nonLocal);
}
