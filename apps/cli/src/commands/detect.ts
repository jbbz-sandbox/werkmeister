/**
 * sandbox detect [feature]
 *
 * Analyze git worktrees in the feature's workspace and report which
 * services would run locally based on changed files.
 */

import { Colors, info, loadServices, resolveWorkspace, warn } from "../lib/config.js";
import { detectChangedServices } from "../lib/detect.js";
import * as fs from "node:fs";

function printResults(detected: string[], servicesConfig: Record<string, any>): void {
  console.log();
  if (detected.length) {
    console.log(
      `  ${Colors.GREEN}${Colors.BOLD}Detected ${detected.length} service(s) with changes:${Colors.RESET}`,
    );
    for (const svc of detected) {
      const svcDef = servicesConfig[svc] ?? {};
      const isDict = typeof svcDef === "object" && svcDef !== null && !Array.isArray(svcDef);
      const repo = isDict ? (svcDef["repo"] ?? "?") : "?";
      const svcType = isDict ? (svcDef["type"] ?? "?") : "?";
      console.log(`    ${Colors.GREEN}*${Colors.RESET} ${svc}  (${repo}, type=${svcType})`);
    }
  } else {
    console.log(`  ${Colors.YELLOW}No services detected with changes.${Colors.RESET}`);
    console.log(`  ${Colors.DIM}This means all services would come from k8s.${Colors.RESET}`);
    console.log(
      `  ${Colors.DIM}Use 'sandbox up <feature> -s <service>' to force a service to run locally.${Colors.RESET}`,
    );
  }

  const detectedSet = new Set(detected);
  const nonLocal = Object.keys(servicesConfig)
    .filter((k) => !detectedSet.has(k))
    .sort();
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

  const workspace = resolveWorkspace(feature, workspaceOverride);
  if (!(fs.existsSync(workspace) && fs.statSync(workspace).isDirectory())) {
    warn(`Workspace not found: ${workspace}`);
    console.log(`\n  ${Colors.DIM}Expected workspace at: ${workspace}${Colors.RESET}`);
    if (!workspaceOverride) {
      console.log(
        `  ${Colors.DIM}Create worktrees there, use --workspace to point to your repos, or check the feature name.${Colors.RESET}`,
      );
    }
    console.log();
    return;
  }

  const servicesConfig = loadServices();
  if (!Object.keys(servicesConfig).length) {
    warn("No services configured in config/services.yaml");
    console.log(`  ${Colors.DIM}Create config/services.yaml with service definitions.${Colors.RESET}`);
    console.log();
    return;
  }

  info(`Workspace: ${workspace}`);
  info(`Service registry: ${Object.keys(servicesConfig).length} service(s) defined\n`);

  const detected = detectChangedServices(feature, servicesConfig, workspaceOverride);
  printResults(detected, servicesConfig);
}
